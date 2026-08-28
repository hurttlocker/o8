import { Schema, type MarkSpec, type NodeSpec } from 'prosemirror-model';

const bodyStyle = [
  'margin:0 0 10px 0',
  'font-family:var(--font-sans-system)',
  'font-size:13.5px',
  'font-weight:300',
  'letter-spacing:-0.1px',
  'line-height:1.5',
  'color:var(--t-text)',
].join(';');

const monoStyle = [
  'font-family:"SF Mono",Menlo,Monaco,"Cascadia Code",ui-monospace,monospace',
  'font-size:12.5px',
].join(';');

const nodes: Record<string, NodeSpec> = {
  doc: {
    content: 'block+',
  },
  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', { style: bodyStyle }, 0],
  },
  heading: {
    attrs: { level: { default: 1 } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
      tag: `h${level}`,
      attrs: { level },
    })),
    toDOM: (node) => {
      const level = Math.min(6, Math.max(1, Number(node.attrs.level)));
      const fontSize = level === 1 ? 18 : level === 2 ? 15.5 : 13.5;
      return [
        `h${level}`,
        {
          style: [
            'margin:0 0 10px 0',
            'font-family:var(--font-sans-system)',
            `font-size:${fontSize}px`,
            'font-weight:400',
            `letter-spacing:${level === 1 ? '-0.2px' : '-0.1px'}`,
            'line-height:1.25',
            'color:var(--t-text)',
          ].join(';'),
        },
        0,
      ];
    },
  },
  bullet_list: {
    content: 'list_item+',
    group: 'block',
    parseDOM: [{ tag: 'ul' }],
    toDOM: () => ['ul', {
      style: `${bodyStyle};padding-left:24px;margin-top:0;margin-bottom:10px`,
    }, 0],
  },
  ordered_list: {
    attrs: { start: { default: 1 } },
    content: 'list_item+',
    group: 'block',
    parseDOM: [{
      tag: 'ol',
      getAttrs: (dom) => ({ start: Number((dom as HTMLElement).getAttribute('start') ?? 1) }),
    }],
    toDOM: (node) => [
      'ol',
      {
        ...(node.attrs.start === 1 ? {} : { start: node.attrs.start }),
        style: `${bodyStyle};padding-left:24px;margin-top:0;margin-bottom:10px`,
      },
      0,
    ],
  },
  list_item: {
    content: 'paragraph block*',
    defining: true,
    parseDOM: [{ tag: 'li' }],
    toDOM: () => ['li', { style: 'margin:0 0 3px 0' }, 0],
  },
  code_block: {
    attrs: {
      lang: { default: null },
      meta: { default: null },
    },
    content: 'text*',
    group: 'block',
    marks: '',
    code: true,
    defining: true,
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM: (node) => ['pre', {
      'data-lang': node.attrs.lang ?? undefined,
      'data-meta': node.attrs.meta ?? undefined,
      style: [
        'margin:0 0 10px 0',
        'padding:10px 12px',
        'border:1px solid var(--t-divider-subtle)',
        'border-radius:8px',
        'background:var(--t-input-bg)',
        'color:var(--t-text)',
        'overflow:auto',
        'white-space:pre-wrap',
        monoStyle,
        'line-height:1.5',
      ].join(';'),
    }, ['code', 0]],
  },
  blockquote: {
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: () => ['blockquote', {
      style: [
        'margin:0 0 10px 0',
        'padding-left:12px',
        'border-left:2px solid var(--t-divider)',
        'color:var(--t-text-muted)',
      ].join(';'),
    }, 0],
  },
  hard_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },
  text: {
    group: 'inline',
  },
};

const marks: Record<string, MarkSpec> = {
  strong: {
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b', getAttrs: (dom) => (dom as HTMLElement).style.fontWeight !== 'normal' && null },
    ],
    toDOM: () => ['strong', { style: 'font-weight:500' }, 0],
  },
  em: {
    parseDOM: [{ tag: 'em' }, { tag: 'i' }],
    toDOM: () => ['em', { style: 'font-style:italic' }, 0],
  },
  code: {
    code: true,
    parseDOM: [{ tag: 'code' }],
    toDOM: () => ['code', {
      style: `${monoStyle};padding:1px 4px;border-radius:4px;background:var(--t-input-bg)`,
    }, 0],
  },
  link: {
    attrs: {
      href: {},
      title: { default: null },
    },
    inclusive: false,
    parseDOM: [{
      tag: 'a[href]',
      getAttrs: (dom) => ({
        href: (dom as HTMLElement).getAttribute('href'),
        title: (dom as HTMLElement).getAttribute('title'),
      }),
    }],
    toDOM: (mark) => ['a', {
      href: mark.attrs.href,
      title: mark.attrs.title ?? undefined,
      rel: 'noreferrer',
      style: 'color:var(--t-accent);text-decoration:underline;text-underline-offset:2px',
    }, 0],
  },
};

export const richMarkdownSchema = new Schema({ nodes, marks });
