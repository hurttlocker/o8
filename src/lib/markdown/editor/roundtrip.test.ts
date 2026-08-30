import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { serializeDocument } from '@/lib/markdown/transport';
import { applyRichDocument, openRichDocument } from './document';
import { richMarkdownSchema } from './schema';

const fixtures = resolve(import.meta.dirname, '../../../../tests/fixtures/markdown/rich-core');

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), 'utf8');
}

const supportedFixtures = [
  'basics.md',
  'nested-lists.md',
  'code-and-quote.md',
  'mixed.md',
];

function replaceChild(doc: ProseMirrorNode, index: number, node: ProseMirrorNode): ProseMirrorNode {
  return doc.copy(doc.content.replaceChild(index, node));
}

function documentWithChildren(doc: ProseMirrorNode, children: ProseMirrorNode[]): ProseMirrorNode {
  return doc.type.createChecked(doc.attrs, children);
}

describe('rich Markdown source contract', () => {
  it.each(supportedFixtures)('keeps %s byte-for-byte with no editor changes', (name) => {
    const source = fixture(name);
    const opened = openRichDocument(source);
    const applied = applyRichDocument(opened.transport, opened.pmDoc);

    expect(opened.blockCount).toBe(opened.transport.blocks.length);
    expect(applied.blocks.every((block) => block.edited === false)).toBe(true);
    expect(serializeDocument(applied)).toBe(source);
  });

  it('changes only the edited heading block bytes', () => {
    const source = fixture('basics.md');
    const opened = openRichDocument(source);
    const heading = opened.pmDoc.child(0);
    const nextHeading = heading.type.createChecked(
      heading.attrs,
      richMarkdownSchema.text('Source-backed heading'),
      heading.marks,
    );
    const applied = applyRichDocument(
      opened.transport,
      replaceChild(opened.pmDoc, 0, nextHeading),
    );

    expect(serializeDocument(applied)).toBe(source.replace(
      '# Rich editor core',
      '# Source-backed heading',
    ));
    expect(applied.blocks[0].edited).toBe(true);
    opened.transport.blocks.slice(1).forEach((block, index) => {
      expect(applied.blocks[index + 1].source).toBe(block.source);
      expect(applied.blocks[index + 1].edited).toBe(false);
    });
  });

  it('preserves surrounding marks when an inline code paragraph is edited', () => {
    const source = 'Before **bold `code` after**.\n';
    const opened = openRichDocument(source);
    const paragraph = opened.pmDoc.child(0);
    const children = Array.from(
      { length: paragraph.childCount },
      (_value, index) => paragraph.child(index),
    );
    const nextParagraph = paragraph.type.createChecked(paragraph.attrs, [
      richMarkdownSchema.text('Changed ', children[0].marks),
      ...children.slice(1),
    ]);
    const applied = applyRichDocument(
      opened.transport,
      replaceChild(opened.pmDoc, 0, nextParagraph),
    );

    expect(serializeDocument(applied)).toBe('Changed **bold `code` after**.\n');
  });

  it('uses star markers and preserves link titles when a paragraph is edited', () => {
    const source = 'Before *emphasis*, **strong**, and [link](https://example.com "Title").\n';
    const opened = openRichDocument(source);
    const paragraph = opened.pmDoc.child(0);
    const children = Array.from(
      { length: paragraph.childCount },
      (_value, index) => paragraph.child(index),
    );
    const nextParagraph = paragraph.type.createChecked(paragraph.attrs, [
      richMarkdownSchema.text('After ', children[0].marks),
      ...children.slice(1),
    ]);
    const applied = applyRichDocument(
      opened.transport,
      replaceChild(opened.pmDoc, 0, nextParagraph),
    );

    expect(serializeDocument(applied)).toBe(
      'After *emphasis*, **strong**, and [link](https://example.com "Title").\n',
    );
  });

  it('keeps a fenced code info string when the code changes', () => {
    const source = '```ts title="source contract" linenos\nconst answer = 42;\n```\n';
    const opened = openRichDocument(source);
    const codeBlock = opened.pmDoc.child(0);
    const nextCodeBlock = codeBlock.type.createChecked(
      codeBlock.attrs,
      richMarkdownSchema.text('const answer = 43;'),
    );
    const applied = applyRichDocument(
      opened.transport,
      replaceChild(opened.pmDoc, 0, nextCodeBlock),
    );

    expect(serializeDocument(applied)).toBe(
      '```ts title="source contract" linenos\nconst answer = 43;\n```\n',
    );
  });

  it.each(['', '\n\n'])('keeps an empty editor document byte-exact for %j', (source) => {
    const opened = openRichDocument(source);
    const applied = applyRichDocument(opened.transport, opened.pmDoc);

    expect(opened.blockCount).toBe(0);
    expect(applied.blocks).toHaveLength(0);
    expect(serializeDocument(applied)).toBe(source);
  });

  it('does not treat literal inline-code contents as math or footnotes', () => {
    const source = 'Literal `$x$ and [^note]` content.\n';
    const opened = openRichDocument(source);

    expect(serializeDocument(applyRichDocument(opened.transport, opened.pmDoc))).toBe(source);
  });

  it('inserts and removes blocks without changing any surviving source slice', () => {
    const source = fixture('mixed.md');
    const opened = openRichDocument(source);
    const originalChildren = Array.from(
      { length: opened.pmDoc.childCount },
      (_value, index) => opened.pmDoc.child(index),
    );
    const insertedParagraph = richMarkdownSchema.nodes.paragraph.createChecked(
      null,
      richMarkdownSchema.text('Inserted paragraph.'),
    );
    const insertedPmDoc = documentWithChildren(opened.pmDoc, [
      originalChildren[0],
      insertedParagraph,
      ...originalChildren.slice(1),
    ]);
    const inserted = applyRichDocument(opened.transport, insertedPmDoc);

    expect(inserted.blocks).toHaveLength(opened.transport.blocks.length + 1);
    expect(inserted.blocks[1].edited).toBe(true);
    opened.transport.blocks.forEach((block, index) => {
      const shiftedIndex = index === 0 ? 0 : index + 1;
      expect(inserted.blocks[shiftedIndex].source).toBe(block.source);
      expect(inserted.blocks[shiftedIndex].edited).toBe(false);
    });

    const withoutOriginalBlockThree = documentWithChildren(insertedPmDoc, [
      insertedPmDoc.child(0),
      insertedPmDoc.child(1),
      insertedPmDoc.child(2),
      ...Array.from(
        { length: insertedPmDoc.childCount - 4 },
        (_value, index) => insertedPmDoc.child(index + 4),
      ),
    ]);
    const removed = applyRichDocument(inserted, withoutOriginalBlockThree);
    const removedOriginal = opened.transport.blocks[2];

    expect(serializeDocument(removed)).not.toContain(removedOriginal.source.trim());
    for (const block of opened.transport.blocks.filter((_block, index) => index !== 2)) {
      expect(removed.blocks.some((candidate) => candidate.source === block.source)).toBe(true);
    }
  });
});

describe('rich Markdown images', () => {
  it('opens and preserves a paragraph image byte-for-byte', () => {
    const source = fixture('unsupported-image.md');
    const opened = openRichDocument(source);
    const applied = applyRichDocument(opened.transport, opened.pmDoc);
    let image = null;
    opened.pmDoc.descendants((node) => {
      if (node.type === richMarkdownSchema.nodes.image) image = node;
    });

    expect(image).toMatchObject({
      attrs: {
        src: './image.png',
        alt: 'Alt text',
        title: 'Image title',
      },
    });
    expect(serializeDocument(applied)).toBe(source);
  });
});
