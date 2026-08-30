import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contentHash,
  insertBlock,
  type MarkdownBlockNode,
  parseDocument,
  replaceBlock,
  removeBlock,
  serializeDocument,
  updateBlockNode,
} from './index';

const repoRoot = resolve(import.meta.dirname, '../../../..');

function markdownFilesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

const corpusPaths = [
  ...markdownFilesUnder(join(repoRoot, 'docs')),
  join(repoRoot, 'CLAUDE.md'),
  join(repoRoot, 'AGENTS.md'),
  join(repoRoot, 'docs/design/DESIGN.md'),
  ...markdownFilesUnder(join(repoRoot, 'tests/fixtures/markdown')),
];

const corpus = corpusPaths.map((path) => ({
  name: relative(repoRoot, path),
  source: readFileSync(path, 'utf8'),
}));

const criticMarkupPattern = /\{(?:==|>>|~~|\+\+|--)/;

interface MutableMdastNode {
  type: string;
  children?: MutableMdastNode[];
  value?: string;
}

function hasParagraph(node: MutableMdastNode): boolean {
  return node.type === 'paragraph' || node.children?.some(hasParagraph) === true;
}

function editFirstParagraph(node: MarkdownBlockNode, nextText: string): MarkdownBlockNode {
  const nextNode = structuredClone(node) as MarkdownBlockNode;
  const visit = (candidate: MutableMdastNode): boolean => {
    if (candidate.type === 'paragraph') {
      candidate.children = [{ type: 'text', value: nextText }];
      return true;
    }
    return candidate.children?.some(visit) === true;
  };
  if (!visit(nextNode as unknown as MutableMdastNode)) {
    throw new Error(`Markdown ${node.type} block contains no paragraph.`);
  }
  return nextNode;
}

describe('Markdown source transport corpus', () => {
  it.each(corpus)('round-trips $name byte-for-byte with no edits', ({ source }) => {
    expect(serializeDocument(parseDocument(source))).toBe(source);
  });

  it.each(corpus)('keeps gap-free, non-overlapping positions for $name', ({ source }) => {
    const doc = parseDocument(source);
    expect(doc.blocks.map((block) => block.source).join('')).toBe(source);

    doc.blocks.forEach((block, index) => {
      expect(block.source).toBe(source.slice(block.start, block.end));
      expect(block.nodeStart).toBe(block.node.position?.start.offset);
      expect(block.nodeEnd).toBe(block.node.position?.end.offset);
      expect(block.nodeStart).toBeGreaterThanOrEqual(block.start);
      expect(block.nodeEnd).toBeLessThanOrEqual(block.end);
      if (index === 0) expect(block.start).toBe(0);
      if (index > 0) expect(block.start).toBe(doc.blocks[index - 1].end);
      if (index === doc.blocks.length - 1) expect(block.end).toBe(source.length);
    });
  });

  it.each(corpus)('isolates one paragraph edit in $name', ({ name, source }) => {
    const doc = parseDocument(source);
    const index = doc.blocks.findIndex((block) => (
      hasParagraph(block.node as unknown as MutableMdastNode)
      && !criticMarkupPattern.test(block.source)
    ));
    expect(index, `${name} must contain an editable paragraph block`).toBeGreaterThanOrEqual(0);

    const nextText = 'Edited paragraph for transport isolation.';
    const nextNode = editFirstParagraph(doc.blocks[index].node, nextText);
    const updated = updateBlockNode(doc, index, nextNode);
    const output = serializeDocument(updated);
    const untouchedLength = doc.blocks.reduce((total, block, blockIndex) => (
      total + (blockIndex === index ? 0 : block.source.length)
    ), 0);
    const editedLength = output.length - untouchedLength;

    expect(updated.blocks[index].edited).toBe(true);
    expect(output).toContain(nextText);
    let outputCursor = 0;
    doc.blocks.forEach((block, blockIndex) => {
      const length = blockIndex === index ? editedLength : block.source.length;
      const outputSlice = output.slice(outputCursor, outputCursor + length);
      if (blockIndex !== index) {
        expect(updated.blocks[blockIndex]).toBe(block);
        expect(outputSlice).toBe(block.source);
      }
      outputCursor += length;
    });
    expect(outputCursor).toBe(output.length);
  });
});

describe('Markdown source transport behavior', () => {
  it('parses frontmatter and GFM nodes with the approved bare extensions', () => {
    const source = readFileSync(join(repoRoot, 'tests/fixtures/markdown/frontmatter-gfm.md'), 'utf8');
    const types = parseDocument(source).blocks.map((block) => block.node.type);
    expect(types).toContain('yaml');
    expect(types).toContain('table');
    expect(types).toContain('list');
  });

  it('keeps CriticMarkup opaque during edited-node serialization', () => {
    const source = 'Before {~~old **value**~>new _value_~~} after\n';
    const doc = parseDocument(source);
    const serialized = serializeDocument(updateBlockNode(doc, 0, doc.blocks[0].node));
    expect(JSON.stringify(doc.blocks[0].node)).not.toContain('"type":"delete"');
    expect(serialized).toBe(source);
  });

  it('captures CRLF and preserves it around an edited block', () => {
    const source = 'First paragraph.\r\n\r\nSecond paragraph.\r\n';
    const doc = parseDocument(source);
    const output = serializeDocument(replaceBlock(doc, 0, 'Replacement paragraph.'));
    expect(doc.lineEnding).toBe('\r\n');
    expect(output).toBe('Replacement paragraph.\r\n\r\nSecond paragraph.\r\n');
  });

  it('returns the standard SHA-256 digest for source text', async () => {
    await expect(contentHash('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('inserts and removes blocks without changing surviving source slices', () => {
    const source = '# One\n\nTwo.\n\nThree.\n';
    const doc = parseDocument(source);
    const inserted = insertBlock(doc, 1, {
      type: 'paragraph',
      children: [{ type: 'text', value: 'Inserted.' }],
    });

    expect(inserted.blocks[0]).toBe(doc.blocks[0]);
    expect(inserted.blocks[2]).toBe(doc.blocks[1]);
    expect(inserted.blocks[3]).toBe(doc.blocks[2]);
    expect(serializeDocument(inserted)).toBe('# One\n\nInserted.\n\nTwo.\n\nThree.\n');

    const removed = removeBlock(inserted, 3);
    expect(removed.blocks[0]).toBe(doc.blocks[0]);
    expect(removed.blocks[2]).toBe(doc.blocks[1]);
    expect(serializeDocument(removed)).toBe('# One\n\nInserted.\n\nTwo.\n\n');
  });
});
