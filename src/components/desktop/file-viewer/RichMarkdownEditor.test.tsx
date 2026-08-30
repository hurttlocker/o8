// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { undo } from 'prosemirror-history';
import { TextSelection } from 'prosemirror-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../FileViewer';
import { getRichMarkdownEditorView } from './RichMarkdownEditor';
import { RICH_MARKDOWN_MAX_SOURCE_BYTES } from '@/lib/markdown/editor';

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

  it('preserves Rich undo history across an unchanged Source round trip', async () => {
    const source = '# Original heading\n';
    const edited = '# Edited heading\n';
    stubMarkdownFile(source);

    await act(async () => {
      root.render(createElement(FileViewer, { filePath: '/notes/undo-round-trip.md' }));
    });
    await settle();

    act(() => button(container, 'Rich').click());
    const mount = container.querySelector<HTMLElement>('[data-rich-markdown-editor="true"]');
    const view = getRichMarkdownEditorView(mount!);
    expect(view).not.toBeNull();

    act(() => {
      view!.dispatch(view!.state.tr.insertText('Edited heading', 1, 17));
    });
    act(() => button(container, 'Source').click());
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="monaco-editor"]')?.value)
      .toBe(edited);
    expect(container.textContent).not.toContain('Rich undo history will restart');

    act(() => button(container, 'Rich').click());
    expect(getRichMarkdownEditorView(mount!)).toBe(view);
    act(() => {
      expect(undo(view!.state, view!.dispatch)).toBe(true);
    });

    act(() => button(container, 'Source').click());
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="monaco-editor"]')?.value)
      .toBe(source);
  });

  it('warns that a Source edit starts a new Rich undo history', async () => {
    const source = '# Original heading\n';
    const sourceEdit = '# Source heading\n';
    stubMarkdownFile(source);

    await act(async () => {
      root.render(createElement(FileViewer, { filePath: '/notes/source-history-boundary.md' }));
    });
    await settle();

    act(() => button(container, 'Rich').click());
    const mount = container.querySelector<HTMLElement>('[data-rich-markdown-editor="true"]');
    const originalView = getRichMarkdownEditorView(mount!);
    act(() => {
      originalView!.dispatch(originalView!.state.tr.insertText('Edited heading', 1, 17));
    });
    act(() => button(container, 'Source').click());

    const monaco = container.querySelector<HTMLTextAreaElement>('[data-testid="monaco-editor"]')!;
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      valueSetter.call(monaco, sourceEdit);
      monaco.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain(
      'Rich undo history will restart because Source mode changed the Markdown.',
    );

    act(() => button(container, 'Rich').click());
    const nextView = getRichMarkdownEditorView(mount!);
    expect(nextView).not.toBe(originalView);
    expect(undo(nextView!.state, nextView!.dispatch)).toBe(false);
    expect(nextView!.state.doc.textContent).toBe('Source heading');
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

  it('opens an existing Markdown image in Rich without changing its source', async () => {
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

    expect(button(container, 'Rich').getAttribute('aria-pressed')).toBe('true');
    const mount = container.querySelector<HTMLElement>('[data-rich-markdown-editor="true"]');
    expect(mount).not.toBeNull();
    const view = getRichMarkdownEditorView(mount!);
    expect(view?.state.doc.child(1).child(0).attrs).toMatchObject({
      src: './image.png',
      alt: 'Alt',
      title: null,
    });
    act(() => button(container, 'Source').click());
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="monaco-editor"]')?.value).toBe(source);
  });

  async function mountImageInputFile(source: string) {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 640,
      height: 480,
      close: vi.fn(),
    })));
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/panel/file-content')) {
        return reply({ content: source, contentHash: 'image-input-hash' });
      }
      if (url.includes('/api/panel/file-diff')) {
        return reply({ diff: '', hasDiff: false });
      }
      if (url.startsWith('/api/repo-spec/asset?repoPath=%2Frepo')) {
        return reply({ ok: true, relPath: 'o8-assets/proof-hash.png' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(createElement(FileViewer, {
        filePath: '/repo/notes/image-input.md',
        workspace: '/repo',
      }));
    });
    await settle();
    act(() => button(container, 'Rich').click());
    const mount = container.querySelector<HTMLElement>('[data-rich-markdown-editor="true"]')!;
    const view = getRichMarkdownEditorView(mount)!;
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, source.length + 1)));
    });
    return view;
  }

  function imageInputEvent(type: 'paste' | 'drop', file: File): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const transfer = {
      files: [file],
      items: [],
      getData: () => '',
      setData: vi.fn(),
      clearData: vi.fn(),
    };
    Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', {
      configurable: true,
      value: transfer,
    });
    return event;
  }

  function richImageAttributes(view: NonNullable<ReturnType<typeof getRichMarkdownEditorView>>) {
    let attributes: Record<string, unknown> | null = null;
    view.state.doc.descendants((node) => {
      if (node.type.name === 'image') attributes = { ...node.attrs };
    });
    return attributes;
  }

  it('pastes an image through FileViewer and writes source-mode-identical bytes', async () => {
    const source = 'Before image';
    const expected = 'Before image\n![proof](o8-assets/proof-hash.png "640x480")';
    const view = await mountImageInputFile(source);
    const event = imageInputEvent(
      'paste',
      new File(['image-bytes'], 'proof.png', { type: 'image/png' }),
    );

    await act(async () => {
      view.dom.dispatchEvent(event);
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(richImageAttributes(view)).toEqual({
      src: 'o8-assets/proof-hash.png',
      alt: 'proof',
      title: '640x480',
    });
    act(() => button(container, 'Source').click());
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="monaco-editor"]')?.value)
      .toBe(expected);
  });

  it('drops an image through FileViewer and writes source-mode-identical bytes', async () => {
    const source = 'Before image';
    const expected = 'Before image\n![proof](o8-assets/proof-hash.png "640x480")';
    const view = await mountImageInputFile(source);
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: source.length + 1, inside: -1 });
    const event = imageInputEvent(
      'drop',
      new File(['image-bytes'], 'proof.png', { type: 'image/png' }),
    );

    await act(async () => {
      view.dom.dispatchEvent(event);
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(richImageAttributes(view)).toEqual({
      src: 'o8-assets/proof-hash.png',
      alt: 'proof',
      title: '640x480',
    });
    act(() => button(container, 'Source').click());
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="monaco-editor"]')?.value)
      .toBe(expected);
  });

  function stubMarkdownFile(source: string): void {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/panel/file-content')) {
        return reply({ content: source, contentHash: 'size-hash' });
      }
      if (url.includes('/api/panel/file-diff')) {
        return reply({ diff: '', hasDiff: false });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
  }

  it('keeps the rich path for a file at the UTF-8 size threshold', async () => {
    const source = `${'a'.repeat(RICH_MARKDOWN_MAX_SOURCE_BYTES - 1)}\n`;
    stubMarkdownFile(source);

    await act(async () => {
      root.render(createElement(FileViewer, { filePath: '/notes/just-under.md' }));
    });
    await settle();

    act(() => button(container, 'Rich').click());
    expect(container.querySelector('[data-rich-markdown-editor="true"]')).not.toBeNull();
    expect(container.textContent).not.toContain('file is');
    expect(button(container, 'Rich').disabled).toBe(false);
  });

  it('opens over-threshold files source-only and explains why in the mode control', async () => {
    const source = `${'a'.repeat(RICH_MARKDOWN_MAX_SOURCE_BYTES)}\n`;
    stubMarkdownFile(source);

    await act(async () => {
      root.render(createElement(FileViewer, { filePath: '/notes/over-size.md' }));
    });
    await settle();

    const rich = button(container, 'Rich');
    expect(rich.disabled).toBe(true);
    expect(container.textContent).toContain(
      `file is ${RICH_MARKDOWN_MAX_SOURCE_BYTES + 1} bytes (limit ${RICH_MARKDOWN_MAX_SOURCE_BYTES})`,
    );
    act(() => rich.click());
    expect(button(container, 'Source').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-rich-markdown-editor="true"]')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="monaco-editor"]')?.value).toBe(source);
  });

  it('counts multibyte source through FileViewer and visibly opens it source-only', async () => {
    const source = `${'a'.repeat(RICH_MARKDOWN_MAX_SOURCE_BYTES - 1)}é`;
    expect(source.length).toBe(RICH_MARKDOWN_MAX_SOURCE_BYTES);
    stubMarkdownFile(source);

    await act(async () => {
      root.render(createElement(FileViewer, { filePath: '/notes/multibyte.md' }));
    });
    await settle();

    expect(button(container, 'Rich').disabled).toBe(true);
    expect(button(container, 'Source').getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain(
      `file is ${RICH_MARKDOWN_MAX_SOURCE_BYTES + 1} bytes (limit ${RICH_MARKDOWN_MAX_SOURCE_BYTES})`,
    );
    expect(container.querySelector('[data-rich-markdown-editor="true"]')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="monaco-editor"]')?.value).toBe(source);
  });

  it('recomputes rich availability in both directions when the same file is reloaded', async () => {
    const initial = '# Small\n';
    const large = `${'a'.repeat(RICH_MARKDOWN_MAX_SOURCE_BYTES)}\n`;
    const smallAgain = '# Small again\n';
    let conflictContent = large;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/panel/file-content')) {
        return reply({ content: initial, contentHash: 'initial-hash' });
      }
      if (url.includes('/api/panel/file-diff')) {
        return reply({ diff: '', hasDiff: false });
      }
      if (url === '/api/v2/files' && init?.method === 'POST') {
        return reply({
          error: 'changed-on-disk',
          content: conflictContent,
          contentHash: `hash-${conflictContent.length}`,
        }, 409);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(createElement(FileViewer, { filePath: '/notes/reloaded.md' }));
    });
    await settle();
    act(() => button(container, 'Rich').click());
    const mount = container.querySelector<HTMLElement>('[data-rich-markdown-editor="true"]');
    const view = getRichMarkdownEditorView(mount!);
    act(() => view!.dispatch(view!.state.tr.insertText(' changed', 2)));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true }));
      await Promise.resolve();
    });
    await settle();
    act(() => button(container, 'Reload').click());

    expect(button(container, 'Rich').disabled).toBe(true);
    expect(button(container, 'Source').getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain(`limit ${RICH_MARKDOWN_MAX_SOURCE_BYTES}`);
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="monaco-editor"]')?.value).toBe(large);

    conflictContent = smallAgain;
    const monaco = container.querySelector<HTMLTextAreaElement>('[data-testid="monaco-editor"]')!;
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      valueSetter.call(monaco, `${large}changed`);
      monaco.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true }));
      await Promise.resolve();
    });
    await settle();
    act(() => button(container, 'Reload').click());

    expect(button(container, 'Rich').disabled).toBe(false);
    expect(button(container, 'Rich').getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).not.toContain(`limit ${RICH_MARKDOWN_MAX_SOURCE_BYTES}`);
    expect(container.querySelector('[data-rich-markdown-editor="true"]')).not.toBeNull();
  });

  it('does not keep rich mode after switching to an over-threshold file', async () => {
    stubMarkdownFile('# Small\n');
    await act(async () => {
      root.render(createElement(FileViewer, { filePath: '/notes/small.md' }));
    });
    await settle();
    act(() => button(container, 'Rich').click());
    expect(container.querySelector('[data-rich-markdown-editor="true"]')).not.toBeNull();

    const large = `${'a'.repeat(RICH_MARKDOWN_MAX_SOURCE_BYTES)}\n`;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/panel/file-content')) {
        return reply({ content: large, contentHash: 'large-hash' });
      }
      if (url.includes('/api/panel/file-diff')) {
        return reply({ diff: '', hasDiff: false });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(createElement(FileViewer, { filePath: '/notes/large.md' }));
    });
    await settle();

    expect(button(container, 'Source').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-rich-markdown-editor="true"]')).toBeNull();
    expect(container.textContent).toContain(`limit ${RICH_MARKDOWN_MAX_SOURCE_BYTES}`);
  });

  it('re-enables rich after switching from an over-threshold file back to a small one', async () => {
    const large = `${'a'.repeat(RICH_MARKDOWN_MAX_SOURCE_BYTES)}\n`;
    stubMarkdownFile(large);
    await act(async () => {
      root.render(createElement(FileViewer, { filePath: '/notes/large-first.md' }));
    });
    await settle();
    expect(button(container, 'Rich').disabled).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/panel/file-content')) {
        return reply({ content: '# Back\n', contentHash: 'back-hash' });
      }
      if (url.includes('/api/panel/file-diff')) {
        return reply({ diff: '', hasDiff: false });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(createElement(FileViewer, { filePath: '/notes/small-again.md' }));
    });
    await settle();

    expect(button(container, 'Rich').disabled).toBe(false);
    act(() => button(container, 'Rich').click());
    expect(container.querySelector('[data-rich-markdown-editor="true"]')).not.toBeNull();
    expect(container.textContent).not.toContain(`limit ${RICH_MARKDOWN_MAX_SOURCE_BYTES}`);
  });
});
