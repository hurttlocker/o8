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
  expect(host.querySelector('[data-file-type]')?.getAttribute('data-file-type')).toBe('ts');
  await click('Edit file');
  const editor = host.querySelector('textarea')!;
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
