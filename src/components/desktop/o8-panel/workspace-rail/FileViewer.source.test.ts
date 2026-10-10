// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./SyntaxFileView', () => ({ SyntaxFileView: ({ content }: { content: string }) => createElement('pre', { 'data-code-reader': true }, content) }));
import { FileViewer } from './FileViewer';
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => Response.json(options?.method ? { ok: true } : { content: 'const value = 1;' })));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const click = (label: string) => act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());

it('reads with colors by default, preserves an edit through reading, and saves to the original scoped route', async () => {
  await act(async () => root.render(createElement(FileViewer, { repoPath: '/workspace', selectedFile: 'src/example.ts' })));
  expect(host.querySelector('[data-code-reader]')?.textContent).toBe('const value = 1;');
  expect(host.querySelector('textarea')).toBeNull();
  const wrap = host.querySelector<HTMLButtonElement>('[aria-label="Word wrap"]')!;
  expect(wrap.getAttribute('aria-pressed')).toBe('true');
  await click('Word wrap');
  expect(wrap.getAttribute('aria-pressed')).toBe('false');
  expect(host.querySelector('[data-file-type]')?.getAttribute('data-file-type')).toBe('ts');
  await click('Edit file');
  const editor = host.querySelector('textarea')!;
  expect(editor.getAttribute('wrap')).toBe('off');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'const value = 2;');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Read file');
  expect(host.querySelector('[data-code-reader]')?.textContent).toBe('const value = 2;');
  expect(host.textContent).toContain('Modified');
  await click('Edit file');
  expect(host.querySelector('textarea')?.value).toBe('const value = 2;');
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click());
  expect(vi.mocked(fetch).mock.calls.at(-1)).toEqual(['/api/v2/files', expect.objectContaining({ method: 'POST', body: JSON.stringify({ path: 'src/example.ts', content: 'const value = 2;', workspace: '/workspace' }) })]);
  expect(host.textContent).not.toContain('Modified');
});

it('shows media controls without reading video bytes as editable text or loading them automatically', async () => {
  await act(async () => root.render(createElement(FileViewer, { repoPath: '/workspace', selectedFile: 'public/demo.mp4' })));
  const player = host.querySelector('video')!;
  expect(player.getAttribute('preload')).toBe('none'); expect(player.controls).toBe(true);
  expect(player.getAttribute('src')).toContain('/api/panel/file-asset?');
  expect(fetch).not.toHaveBeenCalled(); expect(host.querySelector('textarea')).toBeNull(); expect(host.querySelector('[aria-label="Edit file"]')).toBeNull();
});

it('keeps truncated source previews read-only so a partial file can never overwrite the original', async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ content: 'Beginning of a large file', truncated: true }));
  await act(async () => root.render(createElement(FileViewer, { repoPath: '/workspace', selectedFile: 'large.txt' })));
  expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('preview=1');
  expect(host.textContent).toContain('Read-only preview'); expect(host.querySelector('[aria-label="Edit file"]')).toBeNull();
  await act(async () => host.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })));
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method)).toBe(true);
});
