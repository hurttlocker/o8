// @vitest-environment jsdom
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/panel/files/route';
import { QuickDocs } from './QuickDocs';

let host: HTMLDivElement;
let root: Root;
let workspace: string;
const select = vi.fn();
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.localStorage.clear(); select.mockReset();
  workspace = await mkdtemp(join(tmpdir(), 'o8-quick-pins-'));
  await mkdir(join(workspace, 'src')); await writeFile(join(workspace, 'src/useful.ts'), 'export {};');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname.endsWith('/quick-docs')) return Response.json({ groups: [{ label: 'This repo', entries: [{ label: 'Repo instructions', path: 'AGENTS.md', value: 'AGENTS.md' }] }] });
    return GET(new Request(url));
  }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); window.localStorage.clear(); await rm(workspace, { recursive: true, force: true }); });
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 150 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  expect(check()).toBe(true);
}
async function render(repo = workspace) { await act(async () => root.render(createElement(QuickDocs, { repoPath: repo, selectedFile: null, onSelectFile: select }))); }
async function pinUsefulFile() {
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Add file to Quick docs"]')!.click());
  const search = document.querySelector<HTMLInputElement>('[aria-label="Find a file to pin"]')!;
  expect(document.activeElement).toBe(search);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(search, 'useful'); search.dispatchEvent(new Event('input', { bubbles: true })); });
  await waitFor(() => Boolean(document.querySelector('[aria-label="Pin src/useful.ts"]')));
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Pin src/useful.ts"]')!.click());
  expect(document.querySelector('[aria-label="Add a file to Quick docs"]')).toBeNull();
}

it('pins from the file picker, restores the choice after remount, and isolates it by repo', async () => {
  await render(); await pinUsefulFile();
  expect(JSON.parse(window.localStorage.getItem(`o8:quick-docs:pins:v1:${workspace}`)!)).toEqual(['src/useful.ts']);
  await act(async () => root.unmount()); root = createRoot(host); await render();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Quick docs"]')!.click());
  expect(host.textContent).toContain('useful.ts'); expect(host.textContent).toContain('Repo instructions');
  await act(async () => host.querySelector<HTMLButtonElement>('[title="src/useful.ts"]')!.click());
  expect(select).toHaveBeenLastCalledWith('src/useful.ts');
  await render(`${workspace}/another-repo`); expect(host.querySelector('[title="src/useful.ts"]')).toBeNull();
  await render(); await waitFor(() => Boolean(host.querySelector('[title="src/useful.ts"]')));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Unpin src/useful.ts"]')!.click());
  expect(JSON.parse(window.localStorage.getItem(`o8:quick-docs:pins:v1:${workspace}`)!)).toEqual([]);
  expect(host.textContent).toContain('Repo instructions');
});

it('synchronizes pins between two open panes without duplicating the entry', async () => {
  await act(async () => root.render(createElement(Fragment, null, createElement(QuickDocs, { repoPath: workspace, selectedFile: null, onSelectFile: select }), createElement(QuickDocs, { repoPath: workspace, selectedFile: null, onSelectFile: select }))));
  await pinUsefulFile();
  const headers = host.querySelectorAll<HTMLButtonElement>('[aria-label="Quick docs"]');
  await act(async () => headers[1].click());
  expect(host.querySelectorAll('[title="src/useful.ts"]')).toHaveLength(2);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Unpin src/useful.ts"]')!.click());
  expect(host.querySelectorAll('[title="src/useful.ts"]')).toHaveLength(0);
});
