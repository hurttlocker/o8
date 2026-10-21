// @vitest-environment jsdom
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/panel/files/route';
import { AllFilesTree } from './AllFilesTree';

let host: HTMLDivElement;
let root: Root;
let workspace: string;
let requests: Array<{ url: URL; signal?: AbortSignal }>;
const selectFile = vi.fn();

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  workspace = await mkdtemp(join(tmpdir(), 'o8-file-navigation-'));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  requests = []; selectFile.mockReset();
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname.endsWith('quick-docs')) return Response.json({ groups: [] });
    requests.push({ url, signal: init?.signal ?? undefined });
    return GET(new Request(url));
  }));
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
  await rm(workspace, { recursive: true, force: true });
});
async function render(repoPath = workspace, selectedFile: string | null = null) {
  await act(async () => root.render(createElement(AllFilesTree, { repoPath, selectedFile, dirtyFiles: new Set<string>(), onSelectFile: selectFile })));
  await settled(() => Boolean(treeRoot()) && !treeText().includes('Loading files...'));
}
function treeRoot() { return host.querySelector('file-tree-container')?.shadowRoot; }
function treeText() { return `${host.textContent ?? ''}${[...treeRoot()?.querySelectorAll('[role=treeitem]') ?? []].map(node => node.getAttribute('aria-label')).join(' ')}`; }
function item(path: string) { return [...treeRoot()?.querySelectorAll<HTMLButtonElement>('[role=treeitem]') ?? []].find(node => node.dataset.itemPath?.replace(/^f::/, '').replace(/\/$/, '') === path); }
async function settled(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  expect(check()).toBe(true);
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button'), ...treeRoot()?.querySelectorAll<HTMLButtonElement>('button') ?? []].find(node => (node.getAttribute('data-item-path')?.replace(/\/$/, '').split('/').pop() ?? node.textContent?.trim()) === text);
  expect(button, `Button ${text}`).toBeDefined();
  await act(async () => button!.click());
}

describe('workspace file navigation through the directory route', () => {
  it('reveals a linked file through only its ancestors without stealing composer focus', async () => {
    const deep = 'src/app/dashboard';
    await mkdir(join(workspace, deep), { recursive: true });
    await mkdir(join(workspace, 'unopened')); await writeFile(join(workspace, 'unopened', 'other.ts'), 'export {};');
    await writeFile(join(workspace, deep, 'page.tsx'), 'export {};');
    const composer = document.createElement('textarea'); document.body.append(composer); composer.focus();
    await render(workspace, join(workspace, deep, 'page.tsx'));
    await settled(() => treeRoot()?.querySelector('[aria-selected="true"]')?.getAttribute('data-item-path') === `${deep}/page.tsx`);
    expect(requests.map(request => request.url.searchParams.get('directory'))).toEqual(['.', 'src', 'src/app', deep]);
    expect(document.activeElement).toBe(composer);
    await click('dashboard');
    expect(item(deep)?.getAttribute('aria-expanded')).toBe('false');
    await render(workspace, join(workspace, deep, 'page.tsx'));
    expect(item(deep)?.getAttribute('aria-expanded')).toBe('false');
    composer.remove();
  });

  it('does not read folders for a file outside this repo or a missing selected path', async () => {
    await mkdir(join(workspace, 'src'));
    await render(workspace, '/somewhere/else/file.ts');
    expect(requests).toHaveLength(1);
    await render(workspace, 'missing/deep/file.ts');
    expect(requests).toHaveLength(1);
    await render(workspace, '../src/file.ts');
    expect(requests).toHaveLength(1);
  });

  it('stops automatic reveal after a folder error and resumes from its Retry action', async () => {
    await mkdir(join(workspace, 'src')); await writeFile(join(workspace, 'src', 'file.ts'), 'export {};');
    const fetcher = vi.mocked(fetch); const realRead = fetcher.getMockImplementation()!;
    let attempts = 0;
    fetcher.mockImplementation(async (input, init) => {
      const directory = new URL(String(input), 'http://localhost').searchParams.get('directory');
      if (directory === 'src' && ++attempts === 1) return new Response(null, { status: 503 });
      return realRead(input, init);
    });
    await render(workspace, 'src/file.ts');
    await settled(() => Boolean(treeText().includes("Couldn't load this folder.")));
    expect(attempts).toBe(1);
    await click('Retry');
    await settled(() => treeRoot()?.querySelector('[aria-selected="true"]')?.getAttribute('data-item-path') === 'src/file.ts');
    expect(attempts).toBe(2);
  });

  it('opens a file beyond the old depth cap without reading unopened folders', async () => {
    const deep = 'one/two/three/four/five';
    await mkdir(join(workspace, deep), { recursive: true });
    await mkdir(join(workspace, 'constructor'));
    await writeFile(join(workspace, deep, 'leaf.ts'), 'export const value = 1;');
    await writeFile(join(workspace, 'constructor', 'nested.ts'), 'export {};');
    await writeFile(join(workspace, 'README.md'), '# Root');
    await render();
    expect(requests.map(request => request.url.searchParams.get('directory'))).toEqual(['.']);
    expect(treeText()).toContain('README.md');
    for (const [index, name] of deep.split('/').entries()) {
      await click(name);
      const expected = index === 4 ? 'leaf.ts' : deep.split('/')[index + 1];
      await settled(() => Boolean(treeText().includes(expected)));
    }
    await click('leaf.ts');
    expect(selectFile).toHaveBeenCalledWith(`${deep}/leaf.ts`);
    expect(requests).toHaveLength(6);
    await click('five'); await click('five');
    expect(requests).toHaveLength(6);
    await click('constructor'); await settled(() => Boolean(treeText().includes('nested.ts')));
    await click('nested.ts');
    expect(selectFile).toHaveBeenLastCalledWith('constructor/nested.ts');
    expect(requests.every(request => request.url.searchParams.get('workspace') === workspace)).toBe(true);
  });

  it('recovers failed root and folder reads through visible retry actions', async () => {
    await mkdir(join(workspace, 'src')); await writeFile(join(workspace, 'src', 'file.ts'), 'export {};');
    const fetcher = vi.mocked(fetch); const realRead = fetcher.getMockImplementation()!;
    let rootFails = true; let folderFails = true;
    fetcher.mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      const directory = url.searchParams.get('directory');
      if ((directory === '.' && rootFails) || (directory === 'src' && folderFails)) return new Response(null, { status: 503 });
      return realRead(input, init);
    });
    await render(); expect(treeText()).toContain("Couldn't load workspace files.");
    rootFails = false; await click('Retry'); await settled(() => Boolean(treeText().includes('src')));
    await click('src'); await settled(() => Boolean(treeText().includes("Couldn't load this folder.")));
    folderFails = false; await click('Retry'); await settled(() => Boolean(treeText().includes('file.ts')));
    await click('file.ts'); expect(selectFile).toHaveBeenCalledWith('src/file.ts');
  });

  it('refreshes the root and opened folders after files are created', async () => {
    await mkdir(join(workspace, 'src')); await writeFile(join(workspace, 'src', 'before.ts'), 'export {};');
    await render(); await click('src'); await settled(() => Boolean(treeText().includes('before.ts')));
    await writeFile(join(workspace, 'new.md'), '# New'); await writeFile(join(workspace, 'src', 'after.ts'), 'export {};');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Refresh file tree"]')!.click());
    await settled(() => Boolean(treeText().includes('new.md') && treeText().includes('after.ts')));
    expect(item('src')?.getAttribute('aria-expanded')).toBe('true');
    await click('after.ts'); expect(selectFile).toHaveBeenCalledWith('src/after.ts');
  });

  it('cancels old repo reads and ignores late responses after switching workspaces', async () => {
    let finishOld: ((response: Response) => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    const nextRepo = join(workspace, 'next'); await mkdir(nextRepo); await writeFile(join(nextRepo, 'current.ts'), 'export {};');
    const fetcher = vi.mocked(fetch); const realRead = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/files') && url.searchParams.get('workspace') === workspace) {
        oldSignal = init?.signal ?? undefined;
        return new Promise<Response>(resolve => { finishOld = resolve; });
      }
      return realRead(input, init);
    });
    await act(async () => root.render(createElement(AllFilesTree, { repoPath: workspace, selectedFile: null, dirtyFiles: new Set<string>(), onSelectFile: selectFile })));
    await render(nextRepo); expect(oldSignal?.aborted).toBe(true);
    await act(async () => finishOld?.(Response.json({ entries: [{ name: 'stale.ts', path: 'stale.ts', kind: 'file' }] })));
    expect(treeText()).toContain('current.ts'); expect(treeText()).not.toContain('stale.ts');
    await click('current.ts'); expect(selectFile).toHaveBeenCalledWith('current.ts');
  });

  it('shows ignored folders dimmed and lets the user expand them with the keyboard', async () => {
    await mkdir(join(workspace, '.next')); await writeFile(join(workspace, '.next', 'cache.json'), '{}');
    await writeFile(join(workspace, 'README.md'), '# Readme');
    await render();
    expect(item('.next')?.getAttribute('data-item-git-status')).toBe('ignored');
    const directory = item('.next')!;
    await act(async () => { directory.focus(); directory.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, composed: true })); });
    await settled(() => Boolean(item('.next/cache.json')));
    await click('cache.json');
    expect(selectFile).toHaveBeenLastCalledWith('.next/cache.json');
  });

  it('searches unopened folders, opens the match, and restores browsing on Escape', async () => {
    await mkdir(join(workspace, 'src/deep'), { recursive: true });
    await writeFile(join(workspace, 'src/deep/needle.ts'), 'export {};');
    await writeFile(join(workspace, 'README.md'), '# Readme');
    await render();
    const input = host.querySelector<HTMLInputElement>('[aria-label="Search files"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, 'needle'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await settled(() => Boolean(item('src/deep/needle.ts')));
    expect(requests.some(request => request.url.searchParams.get('search') === 'needle')).toBe(true);
    expect(requests.filter(request => request.url.searchParams.has('directory'))).toHaveLength(1);
    await click('needle.ts'); expect(selectFile).toHaveBeenLastCalledWith('src/deep/needle.ts');
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(input.value).toBe('');
    await settled(() => Boolean(item('README.md')));
  });

  it('returns from repeated searches with shared folder ancestors to the full tree', async () => {
    for (const folder of ['cli', 'apps/web']) {
      await mkdir(join(workspace, folder), { recursive: true });
      await writeFile(join(workspace, folder, 'package.json'), '{}');
    }
    await writeFile(join(workspace, 'package.json'), '{}');
    await writeFile(join(workspace, 'README.md'), '# Root');
    await render();
    const input = host.querySelector<HTMLInputElement>('[aria-label="Search files"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    for (let pass = 0; pass < 2; pass++) {
      await act(async () => { setter.call(input, 'package.json'); input.dispatchEvent(new Event('input', { bubbles: true })); });
      await settled(() => Boolean(item('cli/package.json') && item('apps/web/package.json') && item('package.json')));
      await click('package.json');
      await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await settled(() => Boolean(item('README.md') && item('cli')));
      expect(treeText()).toContain('apps');
      expect(treeText()).not.toContain("Couldn't load the file explorer.");
    }
  });
});
