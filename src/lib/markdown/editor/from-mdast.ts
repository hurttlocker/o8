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
  title?: string | null;
  children?: MdastNode[];
  position?: { start?: { line?: number } };
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
  footnoteDefinition: 'footnote',
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

function inlineContent(
  nodes: MdastNode[],
  schema: Schema,
  marks: readonly import('prosemirror-model').Mark[] = [],
  fallbackLine = 1,
): ProseMirrorNode[] {
  const output: ProseMirrorNode[] = [];

  for (const node of nodes) {
    const line = lineFor(node, fallbackLine);
    switch (node.type) {
      case 'text':
        if (node.value) output.push(schema.text(node.value, marks));
        break;
      case 'strong':
        output.push(...inlineContent(
          childrenOf(node, line),
          schema,
          [...marks, schema.marks.strong.create()],
          line,
        ));
        break;
      case 'emphasis':
        output.push(...inlineContent(
          childrenOf(node, line),
          schema,
          [...marks, schema.marks.em.create()],
          line,
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
        ));
        break;
      case 'break':
        output.push(schema.nodes.hard_break.create(null, null, marks));
        break;
      default:
        unsupported(node, fallbackLine);
    }
  }

  return output;
}

function listItemToPm(node: MdastNode, schema: Schema, fallbackLine: number): ProseMirrorNode {
  const line = lineFor(node, fallbackLine);
  if (node.checked !== null && node.checked !== undefined) unsupported(node, line, 'task item');
  const children = childrenOf(node, line).map((child) => blockToPmNode(child as MarkdownBlockNode, schema));
  if (children[0]?.type !== schema.nodes.paragraph) unsupported(node, line, 'list item');
  return schema.nodes.list_item.createChecked(null, children);
}

export function blockToPmNode(mdastNode: MarkdownBlockNode, schema: Schema): ProseMirrorNode {
  const node = mdastNode as unknown as MdastNode;
  const line = lineFor(node);

  switch (node.type) {
    case 'paragraph':
      return schema.nodes.paragraph.createChecked(
        null,
        inlineContent(childrenOf(node, line), schema, [], line),
      );
    case 'heading':
      return schema.nodes.heading.createChecked(
        { level: node.depth ?? 1 },
        inlineContent(childrenOf(node, line), schema, [], line),
      );
    case 'list': {
      const listType = node.ordered ? schema.nodes.ordered_list : schema.nodes.bullet_list;
      const attrs = node.ordered ? { start: node.start ?? 1 } : null;
      return listType.createChecked(
        attrs,
        childrenOf(node, line).map((child) => listItemToPm(child, schema, line)),
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
        childrenOf(node, line).map((child) => blockToPmNode(child as MarkdownBlockNode, schema)),
      );
    default:
      unsupported(node);
  }
}
