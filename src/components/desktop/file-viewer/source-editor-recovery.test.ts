// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { FileViewer } from '../FileViewer';
import { SourceEditor } from './SourceEditor';

const editorLoader = vi.hoisted(() => vi.fn());
vi.mock('./bundled-monaco', () => ({ loadBundledMonacoEditor: editorLoader }));
vi.mock('next/dynamic', async () => {
  const { createElement: element, lazy, Suspense } = await import('react');
  return { default: (load: () => Promise<import('react').ComponentType<import('@monaco-editor/react').EditorProps>>) => {
    const Editor = lazy(async () => ({ default: await load() }));
    return (props: import('@monaco-editor/react').EditorProps) => element(Suspense, { fallback: null }, element(Editor, props));
  } };
});
vi.mock('@monaco-editor/react', () => ({ loader: { init: vi.fn() } }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ themeId: 'dark' }) }));
vi.mock('@/lib/hooks/use-tauri-file-drop', () => ({ useTauriFileDrop: () => ({ dragOver: false }) }));

beforeEach(() => { editorLoader.mockReset().mockImplementation(() => new Promise(() => {})); });

it('keeps the real file readable and offers Retry when editor initialization stalls', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.useFakeTimers();
  const source = '{"name":"editor-recovery-fixture"}\n';
  const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => Response.json(String(input).includes('file-diff') ? { diff: '', hasDiff: false } : { content: source, contentHash: 'source-v1' }));
  vi.stubGlobal('fetch', fetcher);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(FileViewer, { filePath: '/fixture/package.json', workspace: '/fixture' })));
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    const fallback = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Source fallback"]');
    expect(fallback?.value).toBe(source); expect(fallback?.readOnly).toBe(true);
    const retry = [...host.querySelectorAll('button')].find(b => b.textContent === 'Retry editor'); expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Source fallback"]')?.value).toBe(source);
    expect(fetcher.mock.calls.every(([, init]) => !init || (init as RequestInit).method !== 'POST')).toBe(true);
  } finally { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});

it('retries a rejected editor initialization with a fresh loader and preserves source', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const source = 'retained source\n';
  editorLoader.mockRejectedValueOnce(new Error('Editor asset unavailable')).mockResolvedValueOnce(
    ({ value }: import('@monaco-editor/react').EditorProps) => createElement('textarea', { 'aria-label': 'Loaded editor', value, readOnly: true }),
  );
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(SourceEditor, { sourceLabel: 'retained.md', value: source })));
    expect(host.textContent).toContain('Editor unavailable');
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Source fallback"]')?.value).toBe(source);
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry editor');
    await act(async () => retry!.click());
    expect(editorLoader).toHaveBeenCalledTimes(2);
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Loaded editor"]')?.value).toBe(source);
  } finally { await act(async () => root.unmount()); host.remove(); consoleError.mockRestore(); vi.unstubAllGlobals(); }
});

it('keeps a ready resident source hidden while switching to a chat and restores it on return', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  editorLoader.mockResolvedValue(function ReadyEditor({ value, onMount }: import('@monaco-editor/react').EditorProps) {
    useEffect(() => { onMount?.(null as never, null as never); }, [onMount]);
    return createElement('textarea', { 'aria-label': 'Resident editor', value, readOnly: true });
  });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render = (active: boolean) => root.render(createElement('div', {
    'aria-hidden': !active,
    style: { visibility: active ? 'visible' : 'hidden' },
  }, createElement(SourceEditor, { sourceLabel: 'README.md', value: '# Retained file\n' })));
  try {
    await act(async () => render(true));
    const editor = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Resident editor"]')!;
    expect(host.querySelector('textarea[aria-label="Source fallback"]')).toBeNull();
    expect(getComputedStyle(editor).visibility).toBe('visible');
    for (let round = 0; round < 3; round++) {
      await act(async () => render(false));
      expect(getComputedStyle(editor).visibility).toBe('hidden');
      await act(async () => render(true));
      expect(getComputedStyle(editor).visibility).toBe('visible');
      expect(editor.value).toBe('# Retained file\n');
      expect(host.querySelector('textarea[aria-label="Resident editor"]')).toBe(editor);
    }
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
