// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRichDocument, openRichDocument } from '@/lib/markdown/editor';
import { serializeDocument } from '@/lib/markdown/transport';
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
        onChange: (event: Event) => props.onChange?.(
          (event.currentTarget as HTMLTextAreaElement).value,
        ),
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

vi.mock('@/lib/hooks/use-tauri-file-drop', () => ({
  useTauriFileDrop: () => ({ dragOver: false }),
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

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent === label);
  if (!match) throw new Error(`Missing ${label} button.`);
  return match;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe('FileViewer rich Markdown slash menu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperties(Range.prototype, {
      getClientRects: {
        configurable: true,
        value: () => [] as unknown as DOMRectList,
      },
      getBoundingClientRect: {
        configurable: true,
        value: () => new DOMRect(),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(Range.prototype, 'getClientRects');
    Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
    vi.unstubAllGlobals();
  });

  async function mountRichEditor(fileName: string) {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/panel/file-content')) {
        return reply({ content: '', contentHash: 'slash-menu-hash' });
      }
      if (url.includes('/api/panel/file-diff')) {
        return reply({ diff: '', hasDiff: false });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(createElement(FileViewer, { filePath: `/notes/${fileName}.md` }));
    });
    await settle();
    act(() => button(container, 'Rich').click());

    const mount = container.querySelector<HTMLElement>('[data-rich-markdown-editor="true"]');
    const view = mount ? getRichMarkdownEditorView(mount) : null;
    expect(view).not.toBeNull();
    return view!;
  }

  it.each([
    ['heading', '#'],
    ['bullet', '- List item'],
    ['numbered', '1. List item'],
    ['task', '- [ ] Task'],
    ['code', '```\n```'],
    [
      'table',
      '| Column 1 | Column 2 |\n| -------- | -------- |\n|          |          |',
    ],
    ['quote', '> Quote'],
    ['divider', '---'],
  ] as const)('inserts /%s through FileViewer as exact source bytes', async (query, expected) => {
    const view = await mountRichEditor(query);

    act(() => {
      view.dispatch(view.state.tr.insertText(`/${query}`, view.state.selection.from));
    });
    const menu = container.querySelector('[role="listbox"][aria-label="Insert Markdown block"]');
    expect(menu).not.toBeNull();
    expect(menu?.querySelectorAll('[role="option"]')).toHaveLength(1);

    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => view.dom.dispatchEvent(enter));

    expect(enter.defaultPrevented).toBe(true);
    expect(container.querySelector('[aria-label="Insert Markdown block"]')).toBeNull();
    act(() => button(container, 'Source').click());
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="monaco-editor"]')?.value)
      .toBe(expected);

    const reopened = openRichDocument(expected);
    expect(serializeDocument(applyRichDocument(reopened.transport, reopened.pmDoc))).toBe(expected);
  });

  it('filters, cycles, dismisses, and closes on non-matching input from the keyboard', async () => {
    const view = await mountRichEditor('keyboard');

    act(() => {
      view.dispatch(view.state.tr.insertText('/li', view.state.selection.from));
    });
    const options = () => Array.from(
      container.querySelectorAll<HTMLButtonElement>('[aria-label="Insert Markdown block"] [role="option"]'),
    );
    expect(options().map((option) => option.textContent)).toEqual([
      'Bullet listUnordered list',
      'Numbered listOrdered list',
      'Task listUnchecked task',
    ]);
    expect(options().every((option) => option.style.minHeight === '44px')).toBe(true);
    expect(options()[0].getAttribute('aria-selected')).toBe('true');

    const down = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    act(() => view.dom.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    expect(options()[1].getAttribute('aria-selected')).toBe('true');

    const up = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      bubbles: true,
      cancelable: true,
    });
    act(() => view.dom.dispatchEvent(up));
    expect(up.defaultPrevented).toBe(true);
    expect(options()[0].getAttribute('aria-selected')).toBe('true');
    act(() => view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      bubbles: true,
      cancelable: true,
    })));
    expect(options()[2].getAttribute('aria-selected')).toBe('true');

    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => view.dom.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(container.querySelector('[aria-label="Insert Markdown block"]')).toBeNull();
    expect(view.state.doc.textContent).toBe('/li');
    expect(document.activeElement).toBe(view.dom);

    act(() => {
      view.dispatch(view.state.tr.insertText('s', view.state.selection.from));
    });
    expect(options()).toHaveLength(3);
    act(() => {
      view.dispatch(view.state.tr.insertText('?', view.state.selection.from));
    });
    expect(container.querySelector('[aria-label="Insert Markdown block"]')).toBeNull();
    expect(view.state.doc.textContent).toBe('/lis?');
  });
});
