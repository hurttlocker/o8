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
    attrs: { checked: { default: null } },
    content: 'paragraph block*',
    defining: true,
    parseDOM: [{
      tag: 'li',
      getAttrs: (dom) => {
        const checked = (dom as HTMLElement).getAttribute('data-task-checked');
        return { checked: checked === null ? null : checked === 'true' };
      },
    }],
    toDOM: (node) => {
      const checked = typeof node.attrs.checked === 'boolean' ? node.attrs.checked : null;
      if (checked === null) return ['li', { style: 'margin:0 0 3px 0' }, 0];
      return [
        'li',
        {
          'data-task-checked': String(checked),
          style: [
            'display:flex',
            'align-items:flex-start',
            'gap:7px',
            'margin-top:0',
            'margin-right:0',
            'margin-bottom:3px',
            'margin-left:0',
          ].join(';'),
        },
        ['input', {
          type: 'checkbox',
          checked: checked ? 'checked' : undefined,
          'data-task-checkbox': 'true',
          'aria-label': checked ? 'Mark task incomplete' : 'Mark task complete',
          contenteditable: 'false',
          style: [
            'flex:none',
            'width:14px',
            'height:14px',
            'margin-top:3px',
            'margin-right:0',
            'margin-bottom:0',
            'margin-left:0',
            'accent-color:var(--t-accent)',
            'cursor:pointer',
          ].join(';'),
        }],
        ['div', { style: 'min-width:0;flex:1' }, 0],
      ];
    },
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
  opaque_block: {
    attrs: {
      construct: {},
      source: {},
      blockIndex: {},
    },
    group: 'block',
    atom: true,
    selectable: true,
    draggable: false,
    toDOM: (node) => ['div', {
      'data-opaque-construct': String(node.attrs.construct),
      contenteditable: 'false',
    }, String(node.attrs.source)],
  },
  opaque_inline: {
    attrs: {
      construct: {},
      source: {},
    },
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,
    toDOM: (node) => ['span', {
      'data-opaque-inline-construct': String(node.attrs.construct),
      contenteditable: 'false',
      style: monoStyle,
    }, String(node.attrs.source)],
  },
  image: {
    attrs: {
      src: {},
      alt: { default: '' },
      title: { default: null },
    },
    inline: true,
    group: 'inline',
    atom: true,
    draggable: true,
    parseDOM: [{
      tag: 'img[src]',
      getAttrs: (dom) => ({
        src: (dom as HTMLImageElement).getAttribute('src'),
        alt: (dom as HTMLImageElement).getAttribute('alt') ?? '',
        title: (dom as HTMLImageElement).getAttribute('title'),
      }),
    }],
    toDOM: (node) => ['img', {
      src: node.attrs.src,
      alt: node.attrs.alt,
      title: node.attrs.title ?? undefined,
      style: [
        'display:inline-block',
        'max-width:100%',
        'height:auto',
        'border-radius:8px',
        'vertical-align:middle',
      ].join(';'),
    }],
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
