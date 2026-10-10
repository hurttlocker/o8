// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceFilesPane } from './WorkspaceFilesPane';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname.endsWith('quick-docs')) return Response.json({ groups: [] });
    if (url.pathname === '/api/panel/files') return Response.json({ entries: url.searchParams.get('directory') === 'src'
      ? [{ name: 'file.ts', path: 'src/file.ts', kind: 'file' }]
      : [{ name: 'src', path: 'src', kind: 'directory' }] });
    return Response.json({ content: 'const value = 1;' });
  }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function Harness() {
  const [file, setFile] = useState<string | null>('src/file.ts');
  return createElement(WorkspaceFilesPane, { repoPath: '/workspace/files', selectedFile: file, dirtyFiles: new Set<string>(), onSelectFile: setFile });
}

it('gives a file the full pane without losing edits or expanded folders', async () => {
  await act(async () => root.render(createElement(Harness)));
  expect(host.querySelector('[data-file-code-view]')).not.toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Edit file"]')!.click());
  const editor = host.querySelector<HTMLTextAreaElement>('textarea')!;
  expect(editor.value).toBe('const value = 1;');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(editor, 'const value = 2;');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.textContent).toContain('Modified');
  const hide = host.querySelector<HTMLButtonElement>('[aria-label="Hide file tree"]')!;
  const tree = document.getElementById(hide.getAttribute('aria-controls')!)!;
  const directory = tree.querySelector('file-tree-container')?.shadowRoot?.querySelector('[data-item-path="src/"]');
  expect(directory?.getAttribute('aria-expanded')).toBe('true');
  await act(async () => { hide.focus(); hide.click(); });
  expect(tree.hidden).toBe(true);
  expect(host.querySelector('textarea')).toBe(editor);
  expect(editor.value).toBe('const value = 2;');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Show file tree');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Show file tree"]')!.click());
  expect(tree.hidden).toBe(false);
  expect(tree.querySelector('file-tree-container')?.shadowRoot?.querySelector('[data-item-path="src/"]')).toBe(directory);
  expect(directory?.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector('textarea')).toBe(editor);
  expect(editor.value).toBe('const value = 2;');
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});
