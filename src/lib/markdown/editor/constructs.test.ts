import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { serializeDocument } from '@/lib/markdown/transport';
import { applyRichDocument, openRichDocument } from './document';
import { UnsupportedMarkdownError } from './from-mdast';
import { richMarkdownSchema } from './schema';

const fixtures = resolve(
  import.meta.dirname,
  '../../../../tests/fixtures/markdown/rich-core/constructs',
);

const constructFixtures = [
  'frontmatter.md',
  'toml-frontmatter.md',
  'table.md',
  'html.md',
  'math.md',
  'footnote.md',
  'task-item.md',
  'details.md',
  'mixed-constructs.md',
] as const;

const fixturesWithOpaqueBlocks = constructFixtures.filter((name) => name !== 'task-item.md');

function fixture(name: typeof constructFixtures[number]): string {
  return readFileSync(join(fixtures, name), 'utf8');
}

function childrenOf(node: ProseMirrorNode): ProseMirrorNode[] {
  return Array.from({ length: node.childCount }, (_value, index) => node.child(index));
}

function documentWithChildren(doc: ProseMirrorNode, children: ProseMirrorNode[]): ProseMirrorNode {
  return doc.type.createChecked(doc.attrs, children);
}

function editSupportedParagraph(doc: ProseMirrorNode): ProseMirrorNode {
  const children = childrenOf(doc);
  const index = children.findIndex((node) => (
    node.type === richMarkdownSchema.nodes.paragraph && node.textContent.includes('Supported')
  ));
  if (index < 0) throw new Error('Fixture has no supported paragraph.');

  const paragraph = children[index];
  let replaced = false;
  const nextInline = childrenOf(paragraph).map((node) => {
    if (!replaced && node.isText && node.text?.includes('Supported')) {
      replaced = true;
      return richMarkdownSchema.text(node.text.replace('Supported', 'Edited'), node.marks);
    }
    return node;
  });
  children[index] = paragraph.type.createChecked(paragraph.attrs, nextInline, paragraph.marks);
  return documentWithChildren(doc, children);
}

function toggleTaskItem(doc: ProseMirrorNode, itemIndex: number): ProseMirrorNode {
  const children = childrenOf(doc);
  const listIndex = children.findIndex((node) => node.type === richMarkdownSchema.nodes.bullet_list);
  if (listIndex < 0) throw new Error('Fixture has no task list.');
  const list = children[listIndex];
  const item = list.child(itemIndex);
  const nextItem = item.type.createChecked({
    ...item.attrs,
    checked: !item.attrs.checked,
  }, item.content, item.marks);
  children[listIndex] = list.copy(list.content.replaceChild(itemIndex, nextItem));
  return documentWithChildren(doc, children);
}

describe('rich Markdown opaque constructs', () => {
  it.each(constructFixtures)('opens and keeps %s byte-exact when untouched', (name) => {
    const source = fixture(name);
    const opened = openRichDocument(source);

    expect(serializeDocument(applyRichDocument(opened.transport, opened.pmDoc))).toBe(source);
  });

  it.each(constructFixtures)('changes only the supported paragraph block in %s', (name) => {
    const source = fixture(name);
    const opened = openRichDocument(source);
    const editedBlockIndex = opened.transport.blocks.findIndex((block) => (
      block.source.includes('Supported')
    ));
    const applied = applyRichDocument(opened.transport, editSupportedParagraph(opened.pmDoc));

    expect(serializeDocument(applied)).toBe(source.replace('Supported', 'Edited'));
    applied.blocks.forEach((block, index) => {
      if (index === editedBlockIndex) {
        expect(block.edited).toBe(true);
      } else {
        expect(block.source).toBe(opened.transport.blocks[index].source);
        expect(block.edited).toBe(false);
      }
    });
  });

  it.each(fixturesWithOpaqueBlocks)('removes only the selected opaque block from %s', (name) => {
    const source = fixture(name);
    const opened = openRichDocument(source);
    const children = childrenOf(opened.pmDoc);
    const opaqueIndex = children.findIndex((node) => (
      node.type === richMarkdownSchema.nodes.opaque_block
    ));
    if (opaqueIndex < 0) throw new Error(`${name} has no opaque block.`);
    const blockIndex = Number(children[opaqueIndex].attrs.blockIndex);
    const sourceBlock = opened.transport.blocks[blockIndex];
    const applied = applyRichDocument(
      opened.transport,
      documentWithChildren(opened.pmDoc, children.filter((_node, index) => index !== opaqueIndex)),
    );

    expect(serializeDocument(applied)).toBe(
      source.slice(0, sourceBlock.start) + source.slice(sourceBlock.end),
    );
  });

  it('rejects an impossible opaque source mutation', () => {
    const source = fixture('frontmatter.md');
    const opened = openRichDocument(source);
    const children = childrenOf(opened.pmDoc);
    const opaque = children[0];
    children[0] = opaque.type.createChecked({ ...opaque.attrs, source: 'changed' });

    expect(() => applyRichDocument(
      opened.transport,
      documentWithChildren(opened.pmDoc, children),
    )).toThrow('Opaque block source cannot be changed in Rich mode.');
  });

  it.each([
    [0, '- [ ] Completed task\n- [ ] Open task\n'],
    [1, '- [x] Completed task\n- [x] Open task\n'],
  ] as const)('toggles task item %i without changing any other bytes', (itemIndex, taskSource) => {
    const source = fixture('task-item.md');
    const opened = openRichDocument(source);
    const applied = applyRichDocument(opened.transport, toggleTaskItem(opened.pmDoc, itemIndex));

    expect(serializeDocument(applied)).toBe(`Supported paragraph.\n\n${taskSource}`);
  });

  it.each([
    ['Inline double math $$x + y$$ stays unsupported.\n', 1],
    ['Before.\n\nSlash math \\(x + y\\) stays unsupported.\n', 3],
  ])('still rejects unrepresentable math syntax at its exact line', (source, line) => {
    let thrown: unknown;
    try {
      openRichDocument(source);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnsupportedMarkdownError);
    expect(thrown).toMatchObject({ construct: 'math', line });
  });
});
