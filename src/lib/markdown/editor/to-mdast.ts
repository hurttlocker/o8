import type { Mark, Node as ProseMirrorNode } from 'prosemirror-model';
import type { MarkdownBlockNode } from '@/lib/markdown/transport';

interface MdastNode {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  spread?: boolean;
  lang?: string | null;
  meta?: string | null;
  url?: string;
  alt?: string;
  title?: string | null;
  children?: MdastNode[];
}

interface InlineContainer extends MdastNode {
  children: MdastNode[];
}

function sameMark(left: Mark, right: Mark): boolean {
  return left.eq(right);
}

function wrapperFor(mark: Mark): InlineContainer {
  switch (mark.type.name) {
    case 'strong':
      return { type: 'strong', children: [] };
    case 'em':
      return { type: 'emphasis', children: [] };
    case 'link':
      return {
        type: 'link',
        url: String(mark.attrs.href ?? ''),
        title: typeof mark.attrs.title === 'string' ? mark.attrs.title : null,
        children: [],
      };
    default:
      throw new Error(`Unsupported ProseMirror mark: ${mark.type.name}`);
  }
}

function inlineToMdast(node: ProseMirrorNode): MdastNode[] {
  const root: MdastNode[] = [];
  const activeMarks: Mark[] = [];
  const containers: MdastNode[][] = [root];

  node.forEach((child) => {
    const codeMark = child.marks.find((mark) => mark.type.name === 'code');
    const marks = child.marks.filter((mark) => mark.type.name !== 'code');
    let shared = 0;
    while (
      shared < activeMarks.length
      && shared < marks.length
      && sameMark(activeMarks[shared], marks[shared])
    ) {
      shared += 1;
    }
    activeMarks.splice(shared);
    containers.splice(shared + 1);

    for (let index = shared; index < marks.length; index += 1) {
      const wrapper = wrapperFor(marks[index]);
      containers[containers.length - 1].push(wrapper);
      activeMarks.push(marks[index]);
      containers.push(wrapper.children);
    }

    if (child.isText) {
      containers[containers.length - 1].push(codeMark
        ? { type: 'inlineCode', value: child.text ?? '' }
        : { type: 'text', value: child.text ?? '' });
    } else if (child.type.name === 'opaque_inline') {
      containers[containers.length - 1].push({
        type: 'html',
        value: String(child.attrs.source),
      });
    } else if (child.type.name === 'image') {
      containers[containers.length - 1].push({
        type: 'image',
        url: String(child.attrs.src ?? ''),
        alt: String(child.attrs.alt ?? ''),
        title: typeof child.attrs.title === 'string' ? child.attrs.title : null,
      });
    } else if (child.type.name === 'hard_break') {
      containers[containers.length - 1].push({ type: 'break' });
    } else {
      throw new Error(`Unsupported inline ProseMirror node: ${child.type.name}`);
    }
  });

  return root;
}

function listItemToMdast(node: ProseMirrorNode): MdastNode {
  return {
    type: 'listItem',
    checked: typeof node.attrs.checked === 'boolean' ? node.attrs.checked : null,
    spread: false,
    children: Array.from({ length: node.childCount }, (_value, index) => (
      pmNodeToBlock(node.child(index)) as unknown as MdastNode
    )),
  };
}

export function pmNodeToBlock(pmNode: ProseMirrorNode): MarkdownBlockNode {
  let node: MdastNode;

  switch (pmNode.type.name) {
    case 'paragraph':
      node = { type: 'paragraph', children: inlineToMdast(pmNode) };
      break;
    case 'heading':
      node = {
        type: 'heading',
        depth: Number(pmNode.attrs.level),
        children: inlineToMdast(pmNode),
      };
      break;
    case 'bullet_list':
      node = {
        type: 'list',
        ordered: false,
        start: null,
        spread: false,
        children: Array.from({ length: pmNode.childCount }, (_value, index) => (
          listItemToMdast(pmNode.child(index))
        )),
      };
      break;
    case 'ordered_list':
      node = {
        type: 'list',
        ordered: true,
        start: Number(pmNode.attrs.start),
        spread: false,
        children: Array.from({ length: pmNode.childCount }, (_value, index) => (
          listItemToMdast(pmNode.child(index))
        )),
      };
      break;
    case 'code_block':
      node = {
        type: 'code',
        lang: typeof pmNode.attrs.lang === 'string' ? pmNode.attrs.lang : null,
        meta: typeof pmNode.attrs.meta === 'string' ? pmNode.attrs.meta : null,
        value: pmNode.textContent,
      };
      break;
    case 'blockquote':
      node = {
        type: 'blockquote',
        children: Array.from({ length: pmNode.childCount }, (_value, index) => (
          pmNodeToBlock(pmNode.child(index)) as unknown as MdastNode
        )),
      };
      break;
    case 'table':
      node = {
        type: 'table',
        children: [
          {
            type: 'tableRow',
            children: [
              { type: 'tableCell', children: [{ type: 'text', value: 'Column 1' }] },
              { type: 'tableCell', children: [{ type: 'text', value: 'Column 2' }] },
            ],
          },
          {
            type: 'tableRow',
            children: [
              { type: 'tableCell', children: [] },
              { type: 'tableCell', children: [] },
            ],
          },
        ],
      };
      break;
    case 'horizontal_rule':
      node = { type: 'thematicBreak' };
      break;
    default:
      throw new Error(`Unsupported top-level ProseMirror node: ${pmNode.type.name}`);
  }

  return node as unknown as MarkdownBlockNode;
}
