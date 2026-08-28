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
