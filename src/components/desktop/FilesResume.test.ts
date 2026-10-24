// @vitest-environment jsdom
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/panel/files/route';
import { O8Panel } from './O8Panel';
import { BottomUtilitySurface } from './contextual-panel/surfaces';
import type { ContextualPanelHandle } from './ContextualPanel';

// Keep the real utility hosts, Files pane, explorer model and directory route.
vi.mock('./O8ActivityPane', () => ({ O8ActivityPane: () => null }));
vi.mock('./O8HandoffsPane', () => ({ O8HandoffsPane: () => null }));
vi.mock('./O8ResourcesPane', () => ({ O8ResourcesPane: () => null }));
vi.mock('./O8BrowserPane', () => ({ O8BrowserPane: () => null }));
vi.mock('./O8InboxPane', () => ({ O8InboxPane: () => null }));
vi.mock('./o8-panel/O8ThreadsPane', () => ({ O8ThreadsPane: () => null }));
vi.mock('./o8-panel/O8SpecPane', () => ({ O8SpecPane: () => null }));
vi.mock('./comparison/ComparisonMatrix', () => ({ ComparisonMatrix: () => null }));
vi.mock('./review/ReviewPanel', () => ({ ReviewPanel: () => null }));
vi.mock('./o8-panel/O8RepoSelector', () => ({ O8RepoSelector: () => null }));
vi.mock('./o8-panel/TargetsPanel', () => ({ TargetsPanel: () => null }));
vi.mock('./o8-panel/ProjectChangesOverview', () => ({ ProjectChangesOverview: () => null }));
vi.mock('./o8-panel/WorkspaceBrowserPreview', () => ({ WorkspaceBrowserPreview: () => null }));
vi.mock('./ContextualPanel', () => ({ ContextualPanel: () => null }));
vi.mock('./o8-panel/workspace-rail/FileViewer', () => ({ FileViewer: () => null }));

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let workspace: string;
let requests: Array<{ directory: string | null; workspace: string; signal?: AbortSignal }>;
const select = vi.fn();
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  workspace = await mkdtemp(join(tmpdir(), 'o8-files-resume-'));
  await mkdir(join(workspace, 'src')); await mkdir(join(workspace, 'unopened'));
  await writeFile(join(workspace, 'src/before.ts'), 'export {};');
  await writeFile(join(workspace, 'src/other.ts'), 'export {};');
  requests = []; select.mockReset();
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname.endsWith('quick-docs')) return Response.json({ groups: [] });
    if (url.pathname !== '/api/panel/files') return Response.json({});
    requests.push({ directory: url.searchParams.get('directory'), workspace: url.searchParams.get('workspace')!, signal: init?.signal ?? undefined });
    return GET(new Request(url));
  }));
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals();
  await rm(workspace, { recursive: true, force: true });
});
function treeRoot() { return host.querySelector('file-tree-container')?.shadowRoot; }
function item(path: string) { return treeRoot()?.querySelector<HTMLElement>(`[data-item-path="${path}"]`); }
async function settled(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  expect(check()).toBe(true);
}
async function render(surface: 'right' | 'bottom', active: boolean, repoPath = workspace) {
  const pane = surface === 'right'
    ? createElement(O8Panel, { repoPath, activeTab: active ? 'files' : 'review', selectedFile: 'src/before.ts', onSelectedFileChange: select })
    : createElement(BottomUtilitySurface, { kind: 'files', tabId: 'files-resume', active, repoPath, repoLabel: 'Fixture', registeredRepos: [], previews: [], selectedFile: 'src/before.ts', dirtyFiles: new Set<string>(), onSelectFile: select });
  await act(async () => root.render(createElement(QueryClientProvider, { client }, pane)));
}

it.each(['right', 'bottom'] as const)('refreshes the retained %s index on resume without blanking or rebuilding loaded rows', async surface => {
  await render(surface, true);
  await settled(() => Boolean(item('src/before.ts')));
  const folder = item('src/')!;
  const selected = item('src/before.ts')!;
  expect(folder.getAttribute('aria-expanded')).toBe('true');
  expect(selected.getAttribute('aria-selected')).toBe('true');
  expect(requests.map(request => request.directory)).toEqual(['.', 'src']);
  await render(surface, false);
  await writeFile(join(workspace, 'new.md'), '# New');
  await writeFile(join(workspace, 'src/after.ts'), 'export {};');
  await render(surface, false);
  expect(requests).toHaveLength(2);
  const finish: Array<() => Promise<void>> = [];
  const fetcher = vi.mocked(fetch); const read = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input, init) => new Promise<Response>(resolve => { finish.push(async () => { resolve(await read(input, init)); }); }));
  await render(surface, true);
  expect(finish).toHaveLength(2);
  expect(item('src/')).toBe(folder);
  expect(item('src/before.ts')).toBe(selected);
  expect(host.textContent).not.toContain('Loading files...');
  await act(async () => { for (const complete of finish) await complete(); });
  await settled(() => Boolean(item('new.md') && item('src/after.ts')));
  expect(item('src/')).toBe(folder);
  expect(folder.getAttribute('aria-expanded')).toBe('true');
  expect(item('src/before.ts')?.getAttribute('aria-selected')).toBe('true');
  expect(requests.map(request => request.directory)).toEqual(['.', 'src', '.', 'src']);
  await render(surface, true);
  expect(requests).toHaveLength(4);
  await act(async () => item('src/after.ts')!.click());
  expect(select).toHaveBeenCalledWith('src/after.ts');
});

it.each(['right', 'bottom'] as const)('retains the %s workspace index across repository switches while refreshing its loaded folders', async surface => {
  await render(surface, true); await settled(() => Boolean(item('src/before.ts')));
  const folder = item('src/')!; const selected = item('src/before.ts')!;
  const nextRepo = join(workspace, 'next'); await mkdir(nextRepo);
  await writeFile(join(nextRepo, 'other.ts'), 'export {};');
  await render(surface, true, nextRepo); await settled(() => Boolean(item('other.ts')));
  const hidden = (selected.getRootNode() as ShadowRoot).host.closest('[hidden]');
  expect(hidden?.hasAttribute('inert')).toBe(true);
  select.mockClear(); await act(async () => selected.click());
  expect(select).not.toHaveBeenCalled();
  await writeFile(join(workspace, 'src/after.ts'), 'export {};');
  const fetcher = vi.mocked(fetch); const read = fetcher.getMockImplementation()!;
  const pending: Array<() => Promise<void>> = [];
  fetcher.mockImplementation((input, init) => new URL(String(input), 'http://localhost').pathname !== '/api/panel/files'
    ? read(input, init) : new Promise<Response>(resolve => {
      pending.push(async () => resolve(await read(input, init)));
    }));
  await render(surface, true);
  expect(item('src/')).toBe(folder);
  expect(item('src/before.ts')).toBe(selected);
  expect(folder.getAttribute('aria-expanded')).toBe('true');
  expect(selected.getAttribute('aria-selected')).toBe('true');
  expect(host.textContent).not.toContain('Loading files...');
  expect(pending).toHaveLength(2);
  await act(async () => { for (const finish of pending) await finish(); });
  await settled(() => Boolean(item('src/after.ts')));
  expect(item('src/before.ts')?.getAttribute('aria-selected')).toBe('true');
  expect(item('src/')?.getAttribute('aria-expanded')).toBe('true');
  expect(requests.filter(request => request.workspace === nextRepo)).toHaveLength(1);
  await act(async () => item('src/after.ts')!.click());
  expect(select).toHaveBeenCalledWith('src/after.ts');
});

it('evicts the least recently visited workspace after three retained indexes', async () => {
  const repos = new Map<string, string>();
  for (const id of ['b', 'c', 'd']) {
    const path = join(workspace, id); await mkdir(path); await writeFile(join(path, `${id}.ts`), 'export {};'); repos.set(id, path);
  }
  await render('right', true); await settled(() => Boolean(item('src/before.ts')));
  const original = item('src/before.ts')!;
  await render('right', true, repos.get('b')); await settled(() => Boolean(item('b.ts')));
  const evicted = item('b.ts')!;
  await render('right', true, repos.get('c')); await settled(() => Boolean(item('c.ts')));
  await render('right', true); await settled(() => Boolean(item('src/before.ts')));
  expect(item('src/before.ts')).toBe(original);
  await render('right', true, repos.get('d')); await settled(() => Boolean(item('d.ts')));
  expect(host.querySelectorAll('file-tree-container')).toHaveLength(3);
  expect(evicted.isConnected).toBe(false);
  await render('right', true, repos.get('b')); await settled(() => Boolean(item('b.ts')));
  expect(item('b.ts')).not.toBe(evicted);
  expect(host.querySelectorAll('file-tree-container')).toHaveLength(3);
});

it('does not evict a loaded index for workspace switches while Files is inactive', async () => {
  const repos: string[] = [];
  for (const id of ['b', 'c', 'd']) {
    const path = join(workspace, id); await mkdir(path); await writeFile(join(path, `${id}.ts`), 'export {};'); repos.push(path);
  }
  await render('right', true); await settled(() => Boolean(item('src/before.ts')));
  const selected = item('src/before.ts')!;
  const before = requests.length;
  for (const repo of repos) await render('right', false, repo);
  expect(requests).toHaveLength(before);
  await render('right', true);
  expect(item('src/before.ts')).toBe(selected);
});

it.each(['right', 'bottom'] as const)('keeps the %s cached rows usable after failed refreshes and recovers through Retry', async surface => {
  await render(surface, true); await settled(() => Boolean(item('src/before.ts')));
  const folder = item('src/')!; const selected = item('src/before.ts')!;
  await render(surface, false);
  const fetcher = vi.mocked(fetch); const read = fetcher.getMockImplementation()!;
  let fail = true;
  fetcher.mockImplementation((input, init) => new URL(String(input), 'http://localhost').pathname === '/api/panel/files' && fail
    ? Promise.resolve(new Response(null, { status: 503 })) : read(input, init));
  await render(surface, true);
  await settled(() => Boolean(host.textContent?.includes("Couldn't load workspace files.") && host.textContent.includes("Couldn't load this folder.")));
  expect(item('src/')).toBe(folder); expect(item('src/before.ts')).toBe(selected);
  expect(folder.getAttribute('aria-expanded')).toBe('true');
  await act(async () => item('src/other.ts')!.click()); expect(select).toHaveBeenCalledWith('src/other.ts');
  fail = false;
  await writeFile(join(workspace, 'new.md'), '# New'); await writeFile(join(workspace, 'src/after.ts'), 'export {};');
  const retry = [...host.querySelectorAll('button')].filter(button => button.textContent === 'Retry');
  expect(retry).toHaveLength(2);
  await act(async () => { for (const button of retry) button.click(); });
  await settled(() => Boolean(item('new.md') && item('src/after.ts')));
  expect(host.textContent).not.toContain("Couldn't load");
});

it.each(['right', 'bottom'] as const)('ignores late %s refresh responses after a workspace replacement', async surface => {
  await render(surface, true); await settled(() => Boolean(item('src/before.ts')));
  await render(surface, false);
  const fetcher = vi.mocked(fetch); const read = fetcher.getMockImplementation()!;
  const pending: Array<{ signal?: AbortSignal | null; finish: () => void }> = [];
  fetcher.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const response = await read(input, init);
    if (url.pathname !== '/api/panel/files' || url.searchParams.get('workspace') !== workspace) return response;
    return new Promise<Response>(resolve => { pending.push({ signal: init?.signal, finish: () => resolve(response) }); });
  });
  await render(surface, true); await settled(() => pending.length === 2);
  const nextRepo = join(workspace, 'next'); await mkdir(nextRepo); await writeFile(join(nextRepo, 'current.ts'), 'export {};');
  await render(surface, true, nextRepo); await settled(() => Boolean(item('current.ts')));
  expect(pending.every(request => request.signal?.aborted)).toBe(true);
  await act(async () => { for (const request of pending) request.finish(); });
  expect(item('current.ts')).not.toBeNull(); expect(item('src/')).toBeNull();
  await act(async () => item('current.ts')!.click()); expect(select).toHaveBeenCalledWith('current.ts');
});

it.each(['right', 'bottom'] as const)('defers the initial %s index read until the pane is selected', async surface => {
  await render(surface, false);
  expect(requests).toHaveLength(0);
  await render(surface, true); await settled(() => Boolean(item('src/before.ts')));
  expect(requests.map(request => request.directory)).toEqual(['.', 'src']);
});

it('refreshes the actual bottom panel when it reopens with Files still selected', async () => {
  const { ContextualPanel } = await vi.importActual<typeof import('./ContextualPanel')>('./ContextualPanel');
  const ref = createRef<ContextualPanelHandle>();
  const callbacks = { sendTerminalCreate: vi.fn(), sendTerminalAttach: vi.fn(), sendTerminalInput: vi.fn(), sendTerminalResize: vi.fn(), sendTerminalDetach: vi.fn(), sendAgentKill: vi.fn(), onClose: vi.fn() };
  const show = (visible: boolean) => act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(ContextualPanel, { ...callbacks, ref, visible, repoPath: workspace, termWsConnected: false }))));
  await show(true); await act(async () => ref.current!.openSurface('files'));
  await settled(() => Boolean(item('src/')));
  await show(false); await writeFile(join(workspace, 'new.md'), '# New');
  expect(requests).toHaveLength(1);
  await show(true); await settled(() => Boolean(item('new.md')));
  expect(requests.map(request => request.directory)).toEqual(['.', '.']);
  expect(callbacks.sendTerminalCreate).not.toHaveBeenCalled();
});

it('bounds resume reads and stops queued work when Files is hidden again', async () => {
  for (let i = 0; i < 6; i++) {
    await mkdir(join(workspace, `dir-${i}`)); await writeFile(join(workspace, `dir-${i}/file.ts`), 'export {};');
  }
  await render('right', true); await settled(() => Boolean(item('src/before.ts')));
  for (let i = 0; i < 6; i++) {
    await act(async () => item(`dir-${i}/`)!.click());
    await settled(() => Boolean(item(`dir-${i}/file.ts`)));
  }
  const before = requests.length;
  expect(before).toBe(8);
  await render('right', false);
  const fetcher = vi.mocked(fetch); const read = fetcher.getMockImplementation()!;
  const pending: Array<() => void> = [];
  let inFlight = 0; let maxInFlight = 0;
  fetcher.mockImplementation(async (input, init) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const response = await read(input, init);
    return new Promise<Response>(resolve => { pending.push(() => { inFlight--; resolve(response); }); });
  });
  await render('right', true); await settled(() => pending.length === 4);
  expect(requests).toHaveLength(before + 4);
  await render('right', false);
  await act(async () => { for (const finish of pending.splice(0)) finish(); });
  expect(inFlight).toBe(0); expect(requests).toHaveLength(before + 4);
  await render('right', true);
  for (let batch = 0; batch < 2; batch++) {
    await settled(() => pending.length === 4);
    await act(async () => { for (const finish of pending.splice(0)) finish(); });
  }
  expect(inFlight).toBe(0); expect(maxInFlight).toBe(4);
  expect(requests).toHaveLength(before + 4 + 8);
  expect(requests.some(request => request.directory === 'unopened')).toBe(false);
});

it('refreshes a retained search on resume without clearing its query', async () => {
  await render('bottom', true); await settled(() => Boolean(item('src/before.ts')));
  const input = host.querySelector<HTMLInputElement>('[aria-label="Search files"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input, 'before'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await settled(() => Boolean(item('src/before.ts') && requests.some(request => request.directory === null)));
  await render('bottom', false);
  await writeFile(join(workspace, 'unopened/before-new.ts'), 'export {};');
  await render('bottom', true);
  await settled(() => Boolean(item('unopened/before-new.ts')));
  expect(input.value).toBe('before');
  expect(requests.filter(request => request.directory === null)).toHaveLength(2);
  expect(requests.some(request => request.directory === 'unopened')).toBe(false);
});

it('does not let an interrupted resume stand in for a later resume', async () => {
  await render('right', true); await settled(() => Boolean(item('src/before.ts')));
  await render('right', false);
  const fetcher = vi.mocked(fetch); const read = fetcher.getMockImplementation()!;
  const pending: Array<{ signal?: AbortSignal | null; finish: () => void }> = [];
  fetcher.mockImplementation(async (input, init) => {
    const response = await read(input, init);
    if (pending.length >= 2) return response;
    return new Promise<Response>(resolve => { pending.push({ signal: init?.signal, finish: () => resolve(response) }); });
  });
  await render('right', true); await settled(() => pending.length === 2);
  await render('right', false);
  await writeFile(join(workspace, 'newest.md'), '# Newest');
  await render('right', true);
  await settled(() => Boolean(item('newest.md')));
  expect(pending.every(request => request.signal?.aborted)).toBe(true);
  await act(async () => { for (const request of pending) request.finish(); });
  expect(item('newest.md')).not.toBeNull();
  expect(requests.map(request => request.directory)).toEqual(['.', 'src', '.', 'src', '.', 'src']);
});
