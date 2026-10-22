// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { RepoCard } from './RepoCard';

// The separate status-hover list consumer is owned by #4185. Exercise the
// actual card/model/header without counting that independent consumer here.
vi.mock('./RepoStatusHover', () => ({ RepoStatusHover: () => null }));

const repo: RepoRegistryEntry = {
  id: 'fixture', name: 'Fixture', localPath: '/workspace/fixture', remoteUrl: 'https://github.com/org/sample',
  defaultBranch: 'main', addedAt: '', lastOpenedAt: null, storagePressureParkingDisabled: false,
  setup: { envMode: 'skip', envFiles: [], installCommand: null, installOnCreateWorkspace: false,
    buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null,
    workspaceIsolationPreference: 'auto' },
};
const list = (number = 27, count = 2) => Response.json({ repo: 'org/sample', prs: [
  ...Array.from({ length: count }, (_, i) => ({ number: number + i, title: 'Fixture PR', state: 'OPEN', headRefName: 'feature',
    author: { login: 'fixture' }, statusCheckRollup: [{ name: 'Check', conclusion: 'success', status: 'completed' }] })),
  { number: 99, state: 'CLOSED' }, { number: 100, state: 'MERGED' },
] });
let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
const reads = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/panel/prs?'));
const cards = () => [...host.children].flatMap(node => [...node.children]) as HTMLDivElement[];
const badges = () => cards().map(card => [...card.querySelectorAll('span')].find(node => /^\d+PR$/.test(node.textContent ?? ''))?.textContent ?? null);
async function settle(ms = 0) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function render(repos: RepoRegistryEntry[] = [repo]) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...repos.map((entry, i) => createElement('section', { key: i }, createElement(RepoCard, {
      repo: entry, workspaceNotice: null, expanded: false, onToggle: () => {},
      onLaunchAgent: () => {}, onOpenWorkspace: () => {}, onOpenGitHub: () => {}, onLocate: () => {},
      onRemove: () => {}, onSaveSetup: async () => {},
    }))),
  ))); await settle();
}
async function hover(open = true) {
  await act(async () => { for (const card of cards()) card.firstElementChild!.dispatchEvent(new MouseEvent(open ? 'mouseover' : 'mouseout', {
    bubbles: true, clientX: 40, clientY: 40, relatedTarget: document.body,
  })); });
  await settle(open ? 120 : 140); await settle();
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 200, 40));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock = vi.fn(async (url: string) => url.startsWith('/api/panel/prs?') ? list() : Response.json({}));
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('shares one badge list lookup across five real repository cards', async () => {
  await render(Array(5).fill(repo)); await hover();
  expect(badges()).toEqual(Array(5).fill('2PR')); expect(reads()).toHaveLength(1);
});
it('reuses a fresh list on card remount and retains badges after hover closes', async () => {
  await render(); await hover(); await hover(false);
  expect(badges()).toEqual(['2PR']);
  await render([]); await render(); await hover();
  expect(badges()).toEqual(['2PR']); expect(reads()).toHaveLength(1);
});
it('does not read lists before hovering or for a card without a remote', async () => {
  await render(); expect(reads()).toHaveLength(0);
  await render([{ ...repo, remoteUrl: null }]); await hover();
  expect(reads()).toHaveLength(0); expect(badges()).toEqual([null]);
});
it('retries a failed initial lookup on the next hover', async () => {
  fetchMock.mockImplementationOnce(async () => new Response('unavailable', { status: 503 }));
  await render(); await hover(); expect(badges()).toEqual([null]);
  await hover(false); await hover();
  expect(badges()).toEqual(['2PR']); expect(reads()).toHaveLength(2);
});
it('switches repository context without displaying old badges or late old replies', async () => {
  let release!: (response: Response) => void;
  fetchMock.mockImplementation((url: string) => url.startsWith('/api/panel/prs?')
    ? url.includes(encodeURIComponent('org/sample')) ? new Promise<Response>(resolve => { release = resolve; }) : Promise.resolve(list(81, 1))
    : Promise.resolve(Response.json({})));
  await render(); await hover();
  await render([{ ...repo, remoteUrl: 'https://github.com/org/other' }]); await settle();
  expect(badges()).toEqual(['1PR']); expect(host.textContent).toContain('PR #81');
  await act(async () => release(list())); await settle();
  expect(badges()).toEqual(['1PR']); expect(host.textContent).not.toContain('PR #27');
});
it('retries an aborted initial request on the next hover', async () => {
  fetchMock.mockImplementationOnce(async () => { throw new DOMException('Canceled', 'AbortError'); });
  await render(); await hover(); await hover(false); await hover();
  expect(badges()).toEqual(['2PR']); expect(reads()).toHaveLength(2);
});
it('clears a loaded badge immediately when changing to an unresolved repository', async () => {
  await render(); await hover(); expect(badges()).toEqual(['2PR']);
  let release!: (response: Response) => void;
  fetchMock.mockImplementation((url: string) => url.startsWith('/api/panel/prs?')
    ? new Promise<Response>(resolve => { release = resolve; }) : Promise.resolve(Response.json({})));
  await render([{ ...repo, remoteUrl: 'https://github.com/org/other' }]);
  expect(badges()).toEqual([null]); expect(host.textContent).not.toContain('PR #27');
  await act(async () => release(list(81, 1))); await settle();
  expect(badges()).toEqual(['1PR']); expect(host.textContent).toContain('PR #81');
});
it('refreshes visible cards at two minutes and stops polling after the hover closes', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  await render(); await hover();
  fetchMock.mockImplementation(async (url: string) => url.startsWith('/api/panel/prs?') ? list(81, 1) : Response.json({}));
  await settle(2 * 60_000 + 1); await settle();
  expect(badges()).toEqual(['1PR']); expect(reads()).toHaveLength(2);
  await hover(false); await settle(5 * 60_000);
  expect(badges()).toEqual(['1PR']); expect(reads()).toHaveLength(2);
});
it('uses the five-minute polling interval in a hidden window', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  await render(); await hover(); await settle(2 * 60_000 + 1);
  expect(reads()).toHaveLength(1);
  await settle(3 * 60_000); expect(reads()).toHaveLength(2);
});
it('keeps known card badges after a rate-limited background refresh', async () => {
  await render(); await hover();
  fetchMock.mockImplementation(async (url: string) => url.startsWith('/api/panel/prs?')
    ? new Response('rate limited', { status: 429 }) : Response.json({}));
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(badges()).toEqual(['2PR']); expect(reads()).toHaveLength(2);
});
it('does not crash the card for a malformed list', async () => {
  fetchMock.mockImplementation(async () => Response.json({ prs: {} }));
  await render(); await hover(); expect(badges()).toEqual([null]);
});
