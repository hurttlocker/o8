import type { Node as ProseMirrorNode, Schema } from 'prosemirror-model';
import type { MarkdownBlockNode } from '@/lib/markdown/transport';

interface MdastNode {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  lang?: string | null;
  meta?: string | null;
  url?: string;
  alt?: string;
  title?: string | null;
  identifier?: string;
  children?: MdastNode[];
  position?: {
    start?: { line?: number; offset?: number };
    end?: { line?: number; offset?: number };
  };
}

export type OpaqueBlockConstruct =
  | 'frontmatter'
  | 'table'
  | 'html'
  | 'details'
  | 'math'
  | 'footnote-definition';

export type OpaqueInlineConstruct = 'math' | 'footnote-reference';

export interface OpaqueInlineRange {
  construct: OpaqueInlineConstruct;
  start: number;
  end: number;
  source: string;
}

export interface BlockMappingOptions {
  source?: string;
  blockSource?: string;
  blockIndex?: number;
  forceOpaqueConstruct?: OpaqueBlockConstruct;
  opaqueInlineRanges?: readonly OpaqueInlineRange[];
}

const CONSTRUCT_NAMES: Record<string, string> = {
  yaml: 'frontmatter',
  toml: 'frontmatter',
  html: 'html',
  table: 'table',
  tableRow: 'table',
  tableCell: 'table',
  image: 'image',
  imageReference: 'image',
  footnoteDefinition: 'footnote definition',
  footnoteReference: 'footnote',
  math: 'math',
  inlineMath: 'math',
  delete: 'strikethrough',
  thematicBreak: 'thematic break',
  definition: 'reference link',
  linkReference: 'reference link',
};

export class UnsupportedMarkdownError extends Error {
  readonly construct: string;
  readonly line: number;

  constructor(construct: string, line: number) {
    super(`${construct} at line ${line}`);
    this.name = 'UnsupportedMarkdownError';
    this.construct = construct;
    this.line = line;
  }
}

function lineFor(node: MdastNode, fallback = 1): number {
  return node.position?.start?.line ?? fallback;
}

function unsupported(node: MdastNode, fallbackLine = 1, construct?: string): never {
  throw new UnsupportedMarkdownError(
    construct ?? CONSTRUCT_NAMES[node.type] ?? node.type,
    lineFor(node, fallbackLine),
  );
}

function childrenOf(node: MdastNode, fallbackLine: number): MdastNode[] {
  if (!Array.isArray(node.children)) unsupported(node, fallbackLine);
  return node.children;
}

function exactNodeSource(node: MdastNode, options: BlockMappingOptions): string | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return options.source !== undefined && start !== undefined && end !== undefined
    ? options.source.slice(start, end)
    : null;
}

function opaqueBlockConstruct(node: MdastNode, source: string): OpaqueBlockConstruct | null {
  switch (node.type) {
    case 'yaml':
    case 'toml':
      return 'frontmatter';
    case 'table':
      return 'table';
    case 'html':
      return /^\s*<details(?:\s|>)/i.test(source) ? 'details' : 'html';
    case 'footnoteDefinition':
      return 'footnote-definition';
    case 'math':
      return 'math';
    default:
      return null;
  }
}

function opaqueBlockNode(
  node: MdastNode,
  schema: Schema,
  options: BlockMappingOptions,
): ProseMirrorNode | null {
  const nodeSource = exactNodeSource(node, options) ?? node.value ?? '';
  const construct = options.forceOpaqueConstruct ?? opaqueBlockConstruct(node, nodeSource);
  if (!construct) return null;
  return schema.nodes.opaque_block.createChecked({
    construct,
    source: options.blockSource ?? nodeSource,
    blockIndex: options.blockIndex ?? -1,
  });
}

const INLINE_MATH_PATTERN = /(?<![\\$])\$(?![\s$])(?:\\.|[^$\r\n])*?(?<![\s\\$])\$(?!\$)/g;

function inlineMathValueMatch(value: string, from: number): RegExpExecArray | null {
  INLINE_MATH_PATTERN.lastIndex = from;
  return INLINE_MATH_PATTERN.exec(value);
}

function appendText(
  output: ProseMirrorNode[],
  schema: Schema,
  value: string,
  marks: readonly import('prosemirror-model').Mark[],
): void {
  if (value) output.push(schema.text(value, marks));
}

function textWithOpaqueRanges(
  node: MdastNode,
  schema: Schema,
  marks: readonly import('prosemirror-model').Mark[],
  options: BlockMappingOptions,
): ProseMirrorNode[] {
  const value = node.value ?? '';
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start === undefined || end === undefined) return value ? [schema.text(value, marks)] : [];
  const ranges = (options.opaqueInlineRanges ?? [])
    .filter((range) => range.start >= start && range.end <= end)
    .sort((left, right) => left.start - right.start);
  if (ranges.length === 0) return value ? [schema.text(value, marks)] : [];

  const raw = options.source?.slice(start, end) ?? value;
  const output: ProseMirrorNode[] = [];
  let valueCursor = 0;

  for (const range of ranges) {
    const relativeStart = range.start - start;
    const exactValueStart = raw === value
      ? relativeStart
      : value.indexOf(range.source, valueCursor);
    const fallbackMatch = exactValueStart < 0 && range.construct === 'math'
      ? inlineMathValueMatch(value, valueCursor)
      : null;
    const valueStart = exactValueStart >= 0 ? exactValueStart : fallbackMatch?.index;
    const valueEnd = exactValueStart >= 0
      ? exactValueStart + range.source.length
      : fallbackMatch ? fallbackMatch.index + fallbackMatch[0].length : undefined;
    if (valueStart === undefined || valueEnd === undefined) {
      throw new UnsupportedMarkdownError(range.construct, lineFor(node));
    }
    appendText(output, schema, value.slice(valueCursor, valueStart), marks);
    output.push(schema.nodes.opaque_inline.createChecked({
      construct: range.construct,
      source: range.source,
    }, null, marks));
    valueCursor = valueEnd;
  }
  appendText(output, schema, value.slice(valueCursor), marks);
  return output;
}

function inlineContent(
  nodes: MdastNode[],
  schema: Schema,
  marks: readonly import('prosemirror-model').Mark[] = [],
  fallbackLine = 1,
  options: BlockMappingOptions = {},
): ProseMirrorNode[] {
  const output: ProseMirrorNode[] = [];

  for (const node of nodes) {
    const line = lineFor(node, fallbackLine);
    switch (node.type) {
      case 'text':
        output.push(...textWithOpaqueRanges(node, schema, marks, options));
        break;
      case 'strong':
        output.push(...inlineContent(
          childrenOf(node, line),
          schema,
          [...marks, schema.marks.strong.create()],
          line,
          options,
        ));
        break;
      case 'emphasis':
        output.push(...inlineContent(
          childrenOf(node, line),
          schema,
          [...marks, schema.marks.em.create()],
          line,
          options,
        ));
        break;
      case 'inlineCode':
        if (node.value) output.push(schema.text(node.value, [
          ...marks,
          schema.marks.code.create(),
        ]));
        break;
      case 'link':
        output.push(...inlineContent(
          childrenOf(node, line),
          schema,
          [...marks, schema.marks.link.create({ href: node.url ?? '', title: node.title ?? null })],
          line,
          options,
        ));
        break;
      case 'image':
        output.push(schema.nodes.image.createChecked({
          src: node.url ?? '',
          alt: node.alt ?? '',
          title: node.title ?? null,
        }, null, marks));
        break;
      case 'break':
        output.push(schema.nodes.hard_break.create(null, null, marks));
        break;
      case 'footnoteReference':
        output.push(schema.nodes.opaque_inline.createChecked({
          construct: 'footnote-reference',
          source: exactNodeSource(node, options) ?? `[^${node.identifier ?? ''}]`,
        }, null, marks));
        break;
      case 'inlineMath':
        output.push(schema.nodes.opaque_inline.createChecked({
          construct: 'math',
          source: exactNodeSource(node, options) ?? node.value ?? '',
        }, null, marks));
        break;
      default:
        unsupported(node, fallbackLine);
    }
  }

  return output;
}

function nestedOptions(options: BlockMappingOptions): BlockMappingOptions {
  return { ...options, blockSource: undefined, forceOpaqueConstruct: undefined };
}

function listItemToPm(
  node: MdastNode,
  schema: Schema,
  fallbackLine: number,
  options: BlockMappingOptions,
): ProseMirrorNode {
  const line = lineFor(node, fallbackLine);
  const children = childrenOf(node, line).map((child) => blockToPmNode(
    child as MarkdownBlockNode,
    schema,
    nestedOptions(options),
  ));
  if (children[0]?.type !== schema.nodes.paragraph) unsupported(node, line, 'list item');
  return schema.nodes.list_item.createChecked({ checked: node.checked ?? null }, children);
}

export function blockToPmNode(
  mdastNode: MarkdownBlockNode,
  schema: Schema,
  options: BlockMappingOptions = {},
): ProseMirrorNode {
  const node = mdastNode as unknown as MdastNode;
  const line = lineFor(node);
  const opaque = opaqueBlockNode(node, schema, options);
  if (opaque) return opaque;

  switch (node.type) {
    case 'paragraph':
      return schema.nodes.paragraph.createChecked(
        null,
        inlineContent(childrenOf(node, line), schema, [], line, options),
      );
    case 'heading':
      return schema.nodes.heading.createChecked(
        { level: node.depth ?? 1 },
        inlineContent(childrenOf(node, line), schema, [], line, options),
      );
    case 'list': {
      const listType = node.ordered ? schema.nodes.ordered_list : schema.nodes.bullet_list;
      const attrs = node.ordered ? { start: node.start ?? 1 } : null;
      return listType.createChecked(
        attrs,
        childrenOf(node, line).map((child) => listItemToPm(child, schema, line, options)),
      );
    }
    case 'code':
      return schema.nodes.code_block.createChecked(
        { lang: node.lang ?? null, meta: node.meta ?? null },
        node.value ? schema.text(node.value) : null,
      );
    case 'blockquote':
      return schema.nodes.blockquote.createChecked(
        null,
        childrenOf(node, line).map((child) => blockToPmNode(
          child as MarkdownBlockNode,
          schema,
          nestedOptions(options),
        )),
      );
    case 'thematicBreak':
      return schema.nodes.horizontal_rule.createChecked();
    default:
      unsupported(node);
  }
}
