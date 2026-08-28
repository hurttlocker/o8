import type { Node as ProseMirrorNode } from 'prosemirror-model';
import {
  insertBlock,
  type MarkdownBlock,
  type MarkdownTransportDocument,
  parseDocument,
  removeBlock,
} from '@/lib/markdown/transport';
import {
  blockToPmNode,
  type OpaqueInlineRange,
  UnsupportedMarkdownError,
} from './from-mdast';
import { richMarkdownSchema } from './schema';
import { pmNodeToBlock } from './to-mdast';

export interface OpenRichDocumentResult {
  transport: MarkdownTransportDocument;
  pmDoc: ProseMirrorNode;
  blockCount: number;
}

interface OriginEntry {
  sourceBlock: MarkdownBlock | null;
  originNode: ProseMirrorNode | null;
}

interface RichDocumentState {
  entries: OriginEntry[];
  currentNodes: ProseMirrorNode[];
  originTransport: MarkdownTransportDocument;
}

const richDocumentStates = new WeakMap<MarkdownTransportDocument, RichDocumentState>();

const inlineMathPattern = /(?<![\\$])\$(?![\s$])(?:\\.|[^$\r\n])*?(?<![\s\\$])\$(?!\$)/g;

const unparsedConstructPatterns = [
  { construct: 'footnote', pattern: /\[\^[^\]\r\n]+\](?::)?/g },
  { construct: 'math', pattern: /(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$/g },
  { construct: 'math', pattern: inlineMathPattern },
  { construct: 'math', pattern: /\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g },
] as const;

const blockMathPattern = /^[ \t]*\$\$(?:[^\r\n]*\$\$|[ \t]*(?:\r\n|\r|\n)[\s\S]*(?:\r\n|\r|\n)[ \t]*\$\$)[ \t]*$/;

function lineAtOffset(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n' || (source[index] === '\r' && source[index + 1] !== '\n')) {
      line += 1;
    }
  }
  return line;
}

function protectedInlineRanges(node: unknown): Array<{ start: number; end: number }> {
  if (!node || typeof node !== 'object') return [];
  const candidate = node as {
    type?: unknown;
    children?: unknown;
    position?: { start?: { offset?: number }; end?: { offset?: number } };
  };
  if (
    candidate.type === 'inlineCode'
    && candidate.position?.start?.offset !== undefined
    && candidate.position.end?.offset !== undefined
  ) {
    return [{
      start: candidate.position.start.offset,
      end: candidate.position.end.offset,
    }];
  }
  return Array.isArray(candidate.children)
    ? candidate.children.flatMap(protectedInlineRanges)
    : [];
}

function positionedRange(node: unknown): { start: number; end: number } | null {
  if (!node || typeof node !== 'object') return null;
  const position = (node as {
    position?: { start?: { offset?: number }; end?: { offset?: number } };
  }).position;
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  return start === undefined || end === undefined ? null : { start, end };
}

function opaqueInlineRanges(node: unknown, source: string): OpaqueInlineRange[] {
  if (!node || typeof node !== 'object') return [];
  const candidate = node as { type?: unknown; children?: unknown };
  const range = positionedRange(candidate);
  if (candidate.type === 'footnoteReference' && range) {
    return [{
      construct: 'footnote-reference',
      ...range,
      source: source.slice(range.start, range.end),
    }];
  }
  if (candidate.type === 'inlineMath' && range) {
    return [{
      construct: 'math',
      ...range,
      source: source.slice(range.start, range.end),
    }];
  }
  if (candidate.type === 'text' && range) {
    const value = source.slice(range.start, range.end);
    const ranges: OpaqueInlineRange[] = [];
    inlineMathPattern.lastIndex = 0;
    for (let match = inlineMathPattern.exec(value); match; match = inlineMathPattern.exec(value)) {
      ranges.push({
        construct: 'math',
        start: range.start + match.index,
        end: range.start + match.index + match[0].length,
        source: match[0],
      });
    }
    return ranges;
  }
  if (candidate.type === 'inlineCode') return [];
  return Array.isArray(candidate.children)
    ? candidate.children.flatMap((child) => opaqueInlineRanges(child, source))
    : [];
}

function isBlockMath(transport: MarkdownTransportDocument, block: MarkdownBlock): boolean {
  if (block.node.type !== 'paragraph') return false;
  return blockMathPattern.test(transport.source.slice(block.nodeStart, block.nodeEnd));
}

function firstUnparsedConstruct(
  transport: MarkdownTransportDocument,
  block: MarkdownBlock,
  opaqueRanges: readonly OpaqueInlineRange[],
): UnsupportedMarkdownError | null {
  if (block.node.type === 'code') return null;
  const nodeSource = transport.source.slice(block.nodeStart, block.nodeEnd);
  const protectedRanges = [...protectedInlineRanges(block.node), ...opaqueRanges];
  let first: { construct: string; offset: number } | null = null;

  for (const { construct, pattern } of unparsedConstructPatterns) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(nodeSource); match; match = pattern.exec(nodeSource)) {
      const absoluteOffset = block.nodeStart + match.index;
      const isProtected = protectedRanges.some(({ start, end }) => (
        absoluteOffset >= start && absoluteOffset < end
      ));
      if (!isProtected && (!first || match.index < first.offset)) {
        first = { construct, offset: match.index };
        break;
      }
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return first
    ? new UnsupportedMarkdownError(
      first.construct,
      lineAtOffset(transport.source, block.nodeStart + first.offset),
    )
    : null;
}

function mappedBlock(
  transport: MarkdownTransportDocument,
  block: MarkdownBlock,
  blockIndex: number,
): ProseMirrorNode {
  const inlineRanges = opaqueInlineRanges(block.node, transport.source);
  const forceOpaqueConstruct = isBlockMath(transport, block) ? 'math' : undefined;
  const unparsed = firstUnparsedConstruct(transport, block, inlineRanges);
  try {
    const mapped = blockToPmNode(block.node, richMarkdownSchema, {
      source: transport.source,
      blockSource: block.source,
      blockIndex,
      forceOpaqueConstruct,
      opaqueInlineRanges: inlineRanges,
    });
    if (mapped.type === richMarkdownSchema.nodes.opaque_block) return mapped;
    if (unparsed) throw unparsed;
    return mapped;
  } catch (error) {
    if (
      unparsed
      && error instanceof UnsupportedMarkdownError
      && error !== unparsed
      && unparsed.line < error.line
    ) {
      throw unparsed;
    }
    throw error;
  }
}

function childrenOf(doc: ProseMirrorNode): ProseMirrorNode[] {
  return Array.from({ length: doc.childCount }, (_value, index) => doc.child(index));
}

function matchingPairs(
  previous: ProseMirrorNode[],
  next: ProseMirrorNode[],
): Array<[number, number]> {
  const rows = previous.length + 1;
  const columns = next.length + 1;
  const table = Array.from({ length: rows }, () => Array<number>(columns).fill(0));

  for (let previousIndex = previous.length - 1; previousIndex >= 0; previousIndex -= 1) {
    for (let nextIndex = next.length - 1; nextIndex >= 0; nextIndex -= 1) {
      const matchScore = previous[previousIndex] === next[nextIndex]
        ? 2
        : previous[previousIndex].eq(next[nextIndex]) ? 1 : 0;
      table[previousIndex][nextIndex] = Math.max(
        table[previousIndex + 1][nextIndex],
        table[previousIndex][nextIndex + 1],
        matchScore > 0 ? table[previousIndex + 1][nextIndex + 1] + matchScore : 0,
      );
    }
  }

  const pairs: Array<[number, number]> = [];
  let previousIndex = 0;
  let nextIndex = 0;
  while (previousIndex < previous.length && nextIndex < next.length) {
    const matchScore = previous[previousIndex] === next[nextIndex]
      ? 2
      : previous[previousIndex].eq(next[nextIndex]) ? 1 : 0;
    if (
      matchScore > 0
      && table[previousIndex][nextIndex]
        === table[previousIndex + 1][nextIndex + 1] + matchScore
    ) {
      pairs.push([previousIndex, nextIndex]);
      previousIndex += 1;
      nextIndex += 1;
    } else if (table[previousIndex + 1][nextIndex] >= table[previousIndex][nextIndex + 1]) {
      previousIndex += 1;
    } else {
      nextIndex += 1;
    }
  }
  return pairs;
}

function alignEntries(
  state: RichDocumentState,
  nextNodes: ProseMirrorNode[],
): OriginEntry[] {
  const matches = matchingPairs(state.currentNodes, nextNodes);
  const entries: OriginEntry[] = [];
  let previousCursor = 0;
  let nextCursor = 0;

  for (const [previousMatch, nextMatch] of [...matches, [state.currentNodes.length, nextNodes.length] as [number, number]]) {
    const previousGap = previousMatch - previousCursor;
    const nextGap = nextMatch - nextCursor;
    const paired = Math.min(previousGap, nextGap);

    for (let offset = 0; offset < paired; offset += 1) {
      entries.push(state.entries[previousCursor + offset]);
    }
    for (let offset = paired; offset < nextGap; offset += 1) {
      entries.push({ sourceBlock: null, originNode: null });
    }
    if (previousMatch < state.currentNodes.length) {
      entries.push(state.entries[previousMatch]);
    }
    previousCursor = previousMatch + 1;
    nextCursor = nextMatch + 1;
  }

  return entries;
}

function stateFor(
  transport: MarkdownTransportDocument,
): RichDocumentState {
  const existing = richDocumentStates.get(transport);
  if (existing) return existing;
  const currentNodes = transport.blocks.map((block, index) => mappedBlock(transport, block, index));
  const state = {
    entries: transport.blocks.map((block, index) => ({
      sourceBlock: block,
      originNode: currentNodes[index],
    })),
    currentNodes,
    originTransport: transport,
  };
  richDocumentStates.set(transport, state);
  return state;
}

export function openRichDocument(source: string): OpenRichDocumentResult {
  const transport = parseDocument(source);
  const mappedNodes = transport.blocks.map((block, index) => mappedBlock(transport, block, index));
  const pmNodes = mappedNodes.length > 0
    ? mappedNodes
    : [richMarkdownSchema.nodes.paragraph.create()];
  const pmDoc = richMarkdownSchema.nodes.doc.createChecked(null, pmNodes);
  richDocumentStates.set(transport, {
    entries: pmNodes.map((_node, index) => ({
      sourceBlock: transport.blocks[index] ?? null,
      originNode: mappedNodes[index] ?? pmNodes[index],
    })),
    currentNodes: pmNodes,
    originTransport: transport,
  });
  return { transport, pmDoc, blockCount: transport.blocks.length };
}

export function applyRichDocument(
  transport: MarkdownTransportDocument,
  pmDoc: ProseMirrorNode,
): MarkdownTransportDocument {
  const state = stateFor(transport);
  const nextNodes = childrenOf(pmDoc);
  const entries = alignEntries(state, nextNodes);
  const hasUnchangedVirtualBlock = entries.some((entry, index) => (
    entry.sourceBlock === null
    && entry.originNode !== null
    && nextNodes[index].eq(entry.originNode)
  ));
  const preservesOpaqueSource = (entry: OriginEntry, node: ProseMirrorNode): boolean => {
    if (entry.originNode?.type !== richMarkdownSchema.nodes.opaque_block) return false;
    if (node.type !== richMarkdownSchema.nodes.opaque_block) return false;
    if (node.attrs.source !== entry.originNode.attrs.source) {
      throw new Error('Opaque block source cannot be changed in Rich mode.');
    }
    return true;
  };
  const originalBlocks = entries.flatMap((entry, index) => {
    if (!entry.sourceBlock || !entry.originNode) return [];
    const node = nextNodes[index];
    const unchanged = node.eq(entry.originNode) || preservesOpaqueSource(entry, node);
    return [{
      ...entry.sourceBlock,
      node: unchanged ? entry.sourceBlock.node : pmNodeToBlock(node),
      edited: !unchanged,
    }];
  });

  const survivingBlocks = new Set(entries.flatMap((entry) => (
    entry.sourceBlock ? [entry.sourceBlock] : []
  )));
  let preservedTransport = state.originTransport;
  for (let index = preservedTransport.blocks.length - 1; index >= 0; index -= 1) {
    if (!survivingBlocks.has(state.originTransport.blocks[index])) {
      preservedTransport = removeBlock(preservedTransport, index);
    }
  }
  let nextTransport: MarkdownTransportDocument = {
    ...preservedTransport,
    source: hasUnchangedVirtualBlock ? state.originTransport.source : preservedTransport.source,
    blocks: originalBlocks,
  };

  entries.forEach((entry, index) => {
    if (!entry.sourceBlock && (!entry.originNode || !nextNodes[index].eq(entry.originNode))) {
      nextTransport = insertBlock(nextTransport, index, pmNodeToBlock(nextNodes[index]));
    }
  });

  richDocumentStates.set(nextTransport, {
    entries,
    currentNodes: nextNodes,
    originTransport: state.originTransport,
  });
  return nextTransport;
}
