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
  await settled(() => !host.textContent?.includes('Loading files...'));
}
async function settled(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  expect(check()).toBe(true);
}
async function click(text: string) {
  const button = Array.from(host.querySelectorAll('button')).find(node => node.textContent?.trim() === text);
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
    await settled(() => host.querySelector('[aria-current="page"]')?.getAttribute('title') === `${deep}/page.tsx`);
    expect(requests.map(request => request.url.searchParams.get('directory'))).toEqual(['.', 'src', 'src/app', deep]);
    expect(document.activeElement).toBe(composer);
    await click('src');
    expect(host.querySelector('[title="src"]')?.getAttribute('aria-expanded')).toBe('false');
    await render(workspace, join(workspace, deep, 'page.tsx'));
    expect(host.querySelector('[title="src"]')?.getAttribute('aria-expanded')).toBe('false');
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
    await settled(() => Boolean(host.textContent?.includes("Couldn't load this folder.")));
    expect(attempts).toBe(1);
    await click('Retry');
    await settled(() => host.querySelector('[aria-current="page"]')?.getAttribute('title') === 'src/file.ts');
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
    expect(host.textContent).toContain('README.md');
    for (const [index, name] of deep.split('/').entries()) {
      await click(name);
      const expected = index === 4 ? 'leaf.ts' : deep.split('/')[index + 1];
      await settled(() => Boolean(host.textContent?.includes(expected)));
    }
    await click('leaf.ts');
    expect(selectFile).toHaveBeenCalledWith(`${deep}/leaf.ts`);
    expect(requests).toHaveLength(6);
    await click('five'); await click('five');
    expect(requests).toHaveLength(6);
    await click('constructor'); await settled(() => Boolean(host.textContent?.includes('nested.ts')));
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
    await render(); expect(host.textContent).toContain("Couldn't load workspace files.");
    rootFails = false; await click('Retry'); await settled(() => Boolean(host.textContent?.includes('src')));
    await click('src'); await settled(() => Boolean(host.textContent?.includes("Couldn't load this folder.")));
    folderFails = false; await click('Retry'); await settled(() => Boolean(host.textContent?.includes('file.ts')));
    await click('file.ts'); expect(selectFile).toHaveBeenCalledWith('src/file.ts');
  });

  it('refreshes the root and opened folders after files are created', async () => {
    await mkdir(join(workspace, 'src')); await writeFile(join(workspace, 'src', 'before.ts'), 'export {};');
    await render(); await click('src'); await settled(() => Boolean(host.textContent?.includes('before.ts')));
    await writeFile(join(workspace, 'new.md'), '# New'); await writeFile(join(workspace, 'src', 'after.ts'), 'export {};');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Refresh file tree"]')!.click());
    await settled(() => Boolean(host.textContent?.includes('new.md') && host.textContent?.includes('after.ts')));
    expect(host.querySelector('[title="src"]')?.getAttribute('aria-expanded')).toBe('true');
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
    expect(host.textContent).toContain('current.ts'); expect(host.textContent).not.toContain('stale.ts');
    await click('current.ts'); expect(selectFile).toHaveBeenCalledWith('current.ts');
  });
});
