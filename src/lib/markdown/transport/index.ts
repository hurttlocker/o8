import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown, frontmatterToMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';

export const MARKDOWN_TRANSPORT_SCHEMA_VERSION = 1 as const;

export type MarkdownTransportSchemaVersion = typeof MARKDOWN_TRANSPORT_SCHEMA_VERSION;
export type MarkdownBlockNode = ReturnType<typeof fromMarkdown>['children'][number];
export type MarkdownLineEnding = '\n' | '\r\n' | '\r' | null;

export interface MarkdownBlock {
  /** Contiguous transport range. All block ranges together cover the source. */
  start: number;
  end: number;
  /** Exact mdast node range inside the transport range. */
  nodeStart: number;
  nodeEnd: number;
  /** Exact original source slice, including inter-block separator space. */
  source: string;
  node: MarkdownBlockNode;
  edited: boolean;
}

export interface MarkdownTransportDocument {
  version: MarkdownTransportSchemaVersion;
  source: string;
  lineEnding: MarkdownLineEnding;
  blocks: MarkdownBlock[];
}

interface CriticMarkupReplacement {
  token: string;
  fragments: string[];
  nextFragment: number;
}

interface ProtectedCriticMarkup {
  value: string;
  restore: (value: string) => string;
}

const CRITIC_MARKUP_PATTERN = /\{(?:~~[\s\S]*?~>[\s\S]*?~~|==[\s\S]*?==|>>[\s\S]*?<<|\+\+[\s\S]*?\+\+|--[\s\S]*?--)\}/g;
const PRIVATE_USE_START = 0xe000;
const PRIVATE_USE_END = 0xf8ff;

const frontmatterKinds: Array<'yaml' | 'toml'> = ['yaml', 'toml'];
const parseExtensions = [gfm(), frontmatter(frontmatterKinds)];
const mdastExtensions = [gfmFromMarkdown(), frontmatterFromMarkdown(frontmatterKinds)];
const serializeExtensions = [gfmToMarkdown(), frontmatterToMarkdown(frontmatterKinds)];

function nextPrivateUseToken(value: string, used: Set<string>, cursor: number): string {
  for (let code = cursor; code <= PRIVATE_USE_END; code += 1) {
    const token = String.fromCharCode(code);
    if (!value.includes(token) && !used.has(token)) return token;
  }
  throw new Error('Markdown contains too many CriticMarkup regions to protect safely.');
}

/**
 * Keep CriticMarkup opaque to the GFM parser. This matters for substitutions:
 * GFM otherwise reads the `~~` delimiters as strikethrough and rewrites them
 * when an edited block is serialized.
 */
function protectCriticMarkup(value: string): ProtectedCriticMarkup {
  const matches = [...value.matchAll(CRITIC_MARKUP_PATTERN)];
  if (matches.length === 0) return { value, restore: (nextValue) => nextValue };

  const used = new Set<string>();
  const replacements: CriticMarkupReplacement[] = [];
  let protectedValue = '';
  let sourceCursor = 0;
  let tokenCursor = PRIVATE_USE_START;

  for (const match of matches) {
    const start = match.index ?? 0;
    const marker = match[0];
    const token = nextPrivateUseToken(value, used, tokenCursor);
    used.add(token);
    tokenCursor = token.charCodeAt(0) + 1;

    const pieces = marker.split(/(\r\n|\r|\n)/);
    const fragments: string[] = [];
    const protectedMarker = pieces.map((piece) => {
      if (piece === '\r\n' || piece === '\r' || piece === '\n') return piece;
      if (piece.length === 0) return '';
      fragments.push(piece);
      return token.repeat(piece.length);
    }).join('');

    protectedValue += value.slice(sourceCursor, start);
    protectedValue += protectedMarker;
    sourceCursor = start + marker.length;
    replacements.push({ token, fragments, nextFragment: 0 });
  }
  protectedValue += value.slice(sourceCursor);

  return {
    value: protectedValue,
    restore: (nextValue) => {
      let restored = nextValue;
      for (const replacement of replacements) {
        restored = restored.replace(
          new RegExp(`${replacement.token}+`, 'g'),
          (protectedFragment) => {
            const original = replacement.fragments[replacement.nextFragment];
            replacement.nextFragment += 1;
            return original ?? protectedFragment;
          },
        );
      }
      return restored;
    },
  };
}

function restoreNodeValues(node: unknown, restore: (value: string) => string): void {
  if (!node || typeof node !== 'object') return;
  const record = node as { value?: unknown; children?: unknown };
  if (typeof record.value === 'string') record.value = restore(record.value);
  if (Array.isArray(record.children)) {
    for (const child of record.children) restoreNodeValues(child, restore);
  }
}

function parseMarkdown(source: string): ReturnType<typeof fromMarkdown> {
  const protectedSource = protectCriticMarkup(source);
  const root = fromMarkdown(protectedSource.value, {
    extensions: parseExtensions,
    mdastExtensions,
  });
  restoreNodeValues(root, protectedSource.restore);
  return root;
}

function lineEndingFor(source: string): MarkdownLineEnding {
  return source.match(/\r\n|\n|\r/)?.[0] as MarkdownLineEnding ?? null;
}

function positionedOffsets(node: MarkdownBlockNode): { start: number; end: number } {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    throw new Error(`Markdown ${node.type} node has no source offsets.`);
  }
  return { start, end };
}

export function parseDocument(source: string): MarkdownTransportDocument {
  const root = parseMarkdown(source);
  const positions = root.children.map(positionedOffsets);
  const blocks = root.children.map((node, index): MarkdownBlock => {
    const nodePosition = positions[index];
    const nextPosition = positions[index + 1];
    const start = index === 0 ? 0 : nodePosition.start;
    const end = nextPosition?.start ?? source.length;

    return {
      start,
      end,
      nodeStart: nodePosition.start,
      nodeEnd: nodePosition.end,
      source: source.slice(start, end),
      node,
      edited: false,
    };
  });

  return {
    version: MARKDOWN_TRANSPORT_SCHEMA_VERSION,
    source,
    lineEnding: lineEndingFor(source),
    blocks,
  };
}

function serializeNode(node: MarkdownBlockNode, lineEnding: Exclude<MarkdownLineEnding, null>): string {
  const output = toMarkdown(
    { type: 'root', children: [node] },
    {
      extensions: serializeExtensions,
      bullet: '-',
      emphasis: '*',
      fence: '`',
      fences: true,
      rule: '-',
      handlers: {
        text(textNode, _parent, state, info) {
          const protectedText = protectCriticMarkup(textNode.value);
          return protectedText.restore(state.safe(protectedText.value, info));
        },
      },
    },
  );
  const withoutDocumentTerminator = output.endsWith('\n') ? output.slice(0, -1) : output;
  return lineEnding === '\n'
    ? withoutDocumentTerminator
    : withoutDocumentTerminator.replace(/\n/g, lineEnding);
}

function serializeBlock(doc: MarkdownTransportDocument, block: MarkdownBlock): string {
  if (!block.edited) return block.source;
  const relativeNodeStart = block.nodeStart - block.start;
  const relativeNodeEnd = block.nodeEnd - block.start;
  const prefix = block.source.slice(0, relativeNodeStart);
  const suffix = block.source.slice(relativeNodeEnd);
  const lineEnding = lineEndingFor(block.source) ?? doc.lineEnding ?? '\n';
  return `${prefix}${serializeNode(block.node, lineEnding)}${suffix}`;
}

export function serializeDocument(doc: MarkdownTransportDocument): string {
  if (doc.version !== MARKDOWN_TRANSPORT_SCHEMA_VERSION) {
    throw new Error(`Unsupported Markdown transport schema version: ${String(doc.version)}`);
  }
  if (doc.blocks.length === 0) return doc.source;
  return doc.blocks.map((block) => serializeBlock(doc, block)).join('');
}

function assertBlockIndex(doc: MarkdownTransportDocument, index: number): MarkdownBlock {
  const block = doc.blocks[index];
  if (!block) throw new RangeError(`Markdown block index is out of range: ${index}`);
  return block;
}

export function updateBlockNode(
  doc: MarkdownTransportDocument,
  index: number,
  node: MarkdownBlockNode,
): MarkdownTransportDocument {
  assertBlockIndex(doc, index);
  return {
    ...doc,
    blocks: doc.blocks.map((block, blockIndex) => blockIndex === index
      ? { ...block, node, edited: true }
      : block),
  };
}

export function replaceBlock(
  doc: MarkdownTransportDocument,
  index: number,
  nextSource: string,
): MarkdownTransportDocument {
  assertBlockIndex(doc, index);
  const replacement = parseMarkdown(nextSource);
  if (replacement.children.length !== 1) {
    throw new Error(`A Markdown block replacement must parse to one top-level node; received ${replacement.children.length}.`);
  }
  return updateBlockNode(doc, index, replacement.children[0]);
}

function insertedBlock(
  doc: MarkdownTransportDocument,
  index: number,
  node: MarkdownBlockNode,
): MarkdownBlock {
  const lineEnding = doc.lineEnding ?? '\n';
  const serialized = serializeNode(node, lineEnding);
  let prefix = '';
  let suffix = '';

  if (doc.blocks.length === 0) {
    suffix = doc.source;
  } else if (index < doc.blocks.length) {
    suffix = `${lineEnding}${lineEnding}`;
  } else {
    const current = serializeDocument(doc);
    if (!current.endsWith(`${lineEnding}${lineEnding}`)) {
      prefix = current.endsWith(lineEnding) ? lineEnding : `${lineEnding}${lineEnding}`;
    }
  }

  return {
    start: 0,
    end: prefix.length + serialized.length + suffix.length,
    nodeStart: prefix.length,
    nodeEnd: prefix.length + serialized.length,
    source: `${prefix}${serialized}${suffix}`,
    node,
    edited: true,
  };
}

export function insertBlock(
  doc: MarkdownTransportDocument,
  index: number,
  node: MarkdownBlockNode,
): MarkdownTransportDocument {
  if (!Number.isInteger(index) || index < 0 || index > doc.blocks.length) {
    throw new RangeError(`Markdown block insertion index is out of range: ${index}`);
  }
  const block = insertedBlock(doc, index, node);
  return {
    ...doc,
    blocks: [
      ...doc.blocks.slice(0, index),
      block,
      ...doc.blocks.slice(index),
    ],
  };
}

export function removeBlock(
  doc: MarkdownTransportDocument,
  index: number,
): MarkdownTransportDocument {
  assertBlockIndex(doc, index);
  const blocks = doc.blocks.filter((_block, blockIndex) => blockIndex !== index);
  return {
    ...doc,
    source: blocks.length === 0 ? '' : doc.source,
    blocks,
  };
}

export async function contentHash(source: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(source),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
