// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TextSelection } from 'prosemirror-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../FileViewer';
import { getRichMarkdownEditorView } from './RichMarkdownEditor';

vi.mock('next/dynamic', async () => {
  const { createElement: createReactElement } = await import('react');
  return {
    default: () => function MonacoEditorStub(props: {
      value: string;
      onChange?: (value: string) => void;
    }) {
      return createReactElement('textarea', {
        'data-testid': 'monaco-editor',
        value: props.value,
        onChange: (event: Event) => props.onChange?.((event.currentTarget as HTMLTextAreaElement).value),
      });
    },
  };
});

vi.mock('@monaco-editor/react', () => ({
  loader: { init: vi.fn() },
}));

vi.mock('@/lib/theme/context', () => ({
  useTheme: () => ({ themeId: 'light-solid' }),
}));

vi.mock('../lucide-shims', () => ({
  FileText: () => createElement('svg', { 'aria-hidden': 'true' }),
}));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

interface FetchReply {
  ok: boolean;
  status: number;
  json: () => Promise<Record<string, unknown>>;
}

function reply(body: Record<string, unknown>, status = 200): FetchReply {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent === label);
  if (!match) throw new Error(`Missing ${label} button.`);
  return match;
}

describe('FileViewer rich Markdown editor', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.restoreAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('saves a ProseMirror block edit through the shared hash-guarded source buffer', async () => {
    const source = '# Original heading\n\nUntouched paragraph.\n';
    const expected = '# Edited heading\n\nUntouched paragraph.\n';
    const postBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/panel/file-content')) {
        return reply({ content: source, contentHash: 'hash-before' });
      }
      if (url.includes('/api/panel/file-diff')) {
        return reply({ diff: '', hasDiff: false });
      }
      if (url === '/api/v2/files' && init?.method === 'POST') {
        postBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return reply({ contentHash: 'hash-after' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(createElement(FileViewer, { filePath: '/notes/supported.md' }));
    });
    await settle();

    act(() => button(container, 'Rich').click());
    const mount = container.querySelector<HTMLElement>('[data-rich-markdown-editor="true"]');
    expect(mount).not.toBeNull();
    const view = getRichMarkdownEditorView(mount!);
    expect(view).not.toBeNull();

    act(() => {
      view!.dispatch(view!.state.tr.insertText('Edited heading', 1, 17));
    });
    expect(view!.sourceChangeCount).toBe(1);

    const sourceChangeCount = view!.sourceChangeCount;
    act(() => {
      view!.dispatch(view!.state.tr.setSelection(TextSelection.create(view!.state.doc, 1)));
    });
    expect(view!.state.selection.from).toBe(1);
    expect(view!.sourceChangeCount).toBe(sourceChangeCount);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true }));
      await Promise.resolve();
    });
    await settle();

    expect(postBodies).toHaveLength(1);
    expect(postBodies[0]).toMatchObject({
      path: '/notes/supported.md',
      content: expected,
      expectedHash: 'hash-before',
    });
    expect(getRichMarkdownEditorView(mount!)).toBe(view);

    act(() => button(container, 'Source').click());
    const monaco = container.querySelector<HTMLTextAreaElement>('[data-testid="monaco-editor"]');
    expect(monaco?.value).toBe(expected);
  });

  it('opens opaque constructs in Rich mode and saves only the paragraph edit', async () => {
    const frontmatter = '---\ntitle: Exact bytes\nspacing:  untouched\n---\n\n';
    const table = '| Name  | Value |\n| :---- | ----: |\n| one   |   two |\n\n';
    const source = `${frontmatter}${table}Original paragraph.\n`;
    const expected = `${frontmatter}${table}Edited paragraph.\n`;
    const postBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/panel/file-content')) {
        return reply({ content: source, contentHash: 'constructs-before' });
      }
      if (url.includes('/api/panel/file-diff')) {
        return reply({ diff: '', hasDiff: false });
      }
      if (url === '/api/v2/files' && init?.method === 'POST') {
        postBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return reply({ contentHash: 'constructs-after' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(createElement(FileViewer, { filePath: '/notes/constructs.md' }));
    });
    await settle();

    act(() => button(container, 'Rich').click());
    const mount = container.querySelector<HTMLElement>('[data-rich-markdown-editor="true"]');
    expect(mount).not.toBeNull();
    expect(container.textContent).not.toContain('Rich mode unavailable');
    expect(container.querySelector('[data-opaque-construct="frontmatter"]')?.textContent)
      .toContain('FRONTMATTER');
    expect(container.querySelector('[data-opaque-construct="table"]')?.textContent)
      .toContain('TABLE');
    const view = getRichMarkdownEditorView(mount!);
    expect(view).not.toBeNull();

    let paragraphFrom = -1;
    let paragraphTo = -1;
    view!.state.doc.forEach((node, offset) => {
      if (node.type === view!.state.schema.nodes.paragraph) {
        paragraphFrom = offset + 1;
        paragraphTo = paragraphFrom + node.content.size;
      }
    });
    act(() => {
      view!.dispatch(view!.state.tr.insertText('Edited paragraph.', paragraphFrom, paragraphTo));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true }));
      await Promise.resolve();
    });
    await settle();

    expect(postBodies).toHaveLength(1);
    expect(postBodies[0]).toMatchObject({
      path: '/notes/constructs.md',
      content: expected,
      expectedHash: 'constructs-before',
    });
    expect(String(postBodies[0].content).slice(0, frontmatter.length)).toBe(frontmatter);
    expect(String(postBodies[0].content).slice(frontmatter.length, frontmatter.length + table.length))
      .toBe(table);
  });

  it('stays in Source and explains the first unsupported construct', async () => {
    const source = 'Supported paragraph.\n\n![Alt](./image.png)\n';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/panel/file-content')) {
        return reply({ content: source, contentHash: 'unsupported-hash' });
      }
      if (url.includes('/api/panel/file-diff')) {
        return reply({ diff: '', hasDiff: false });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(createElement(FileViewer, { filePath: '/notes/unsupported.md' }));
    });
    await settle();

    act(() => button(container, 'Rich').click());

    expect(button(container, 'Source').getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('Rich mode unavailable: image at line 3');
    expect(container.querySelector('[data-rich-markdown-editor="true"]')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="monaco-editor"]')?.value).toBe(source);
  });
});
