// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { RepoStatusHover, type RepoStatusHoverProps } from './RepoStatusHover';

const repo: RepoRegistryEntry = {
  id: 'fixture', name: 'Fixture', localPath: '/workspace/fixture', remoteUrl: 'https://github.com/org/sample',
  defaultBranch: 'main', addedAt: '', lastOpenedAt: null, storagePressureParkingDisabled: false,
  setup: { envMode: 'skip', envFiles: [], installCommand: null, installOnCreateWorkspace: false,
    buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null,
    workspaceIsolationPreference: 'auto' },
};
const props: RepoStatusHoverProps = { repo, anchorRect: new DOMRect(20, 20, 200, 40), agents: [], githubSlug: 'org/sample' };
const list = (count = 2) => Response.json({ repo: 'org/sample', prs: [
  ...Array.from({ length: count }, (_, i) => ({ number: i + 1, state: 'OPEN', reviewDecision: i === 0 ? 'APPROVED' : 'REVIEW_REQUIRED' })),
  { number: 99, state: 'CLOSED', reviewDecision: null }, { number: 100, state: 'MERGED', reviewDecision: null },
] });
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
const reads = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/panel/prs?'));
const values = () => [...document.querySelectorAll('div')]
  .filter(node => node.textContent === 'Pull requests')
  .map(node => node.nextElementSibling?.textContent);

async function settle() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function render(entries: Partial<RepoStatusHoverProps>[] = [{}]) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...entries.map((entry, index) => createElement(RepoStatusHover, { ...props, ...entry, key: index })),
  )));
  await settle();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock = vi.fn(async (input: string) => input.startsWith('/api/panel/prs?') ? list()
    : Response.json(input.startsWith('/api/panel/ci?') ? { runs: [] } : { branch: 'feature' }));
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('shares one PR-list read across five actual repository status hovers', async () => {
  await render(Array.from({ length: 5 }, () => ({})));
  expect(values()).toEqual(Array(5).fill('2 open·1 awaiting review'));
  expect(reads()).toHaveLength(1);
});

it('reuses the fresh PR list after closing and remounting the hover', async () => {
  await render(); await render([]); await render();
  expect(values()).toEqual(['2 open·1 awaiting review']);
  expect(reads()).toHaveLength(1);
});

it('does not start a PR-list read until the hover opens', async () => {
  await render([{ anchorRect: null }]);
  expect(reads()).toHaveLength(0); expect(values()).toEqual([]);
  await render();
  expect(values()).toEqual(['2 open·1 awaiting review']); expect(reads()).toHaveLength(1);
});

it('does not read a PR list without a remote', async () => {
  await render([{ githubSlug: null }]);
  expect(reads()).toHaveLength(0); expect(values()).toEqual(['No remote']);
});

it('isolates counts for different repository slugs', async () => {
  fetchMock.mockImplementation(async (url: string) => url.startsWith('/api/panel/prs?')
    ? list(url.includes(encodeURIComponent('org/other')) ? 1 : 2) : Response.json({}));
  await render([{}, { githubSlug: 'org/other' }]);
  expect(values()).toEqual(['2 open·1 awaiting review', '1 open']); expect(reads()).toHaveLength(2);
});

it('never shows a delayed old-repository result after changing the hover repository', async () => {
  let release!: (response: Response) => void;
  fetchMock.mockImplementation((url: string) => url.includes(encodeURIComponent('org/sample')) && url.startsWith('/api/panel/prs?')
    ? new Promise<Response>(resolve => { release = resolve; }) : Promise.resolve(url.startsWith('/api/panel/prs?') ? list(1) : Response.json({})));
  await render(); await render([{ githubSlug: 'org/other' }]);
  expect(values()).toEqual(['1 open']);
  await act(async () => release(list())); await settle();
  expect(values()).toEqual(['1 open']);
});

it('uses five-minute PR-list polling while the window is hidden', async () => {
  vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  await render(); expect(reads()).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(2 * 60_000 + 1));
  expect(reads()).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(3 * 60_000));
  expect(reads()).toHaveLength(2); expect(values()).toEqual(['2 open·1 awaiting review']);
});

it('refreshes at two minutes while visible and stops polling when the hover closes', async () => {
  vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  await render();
  fetchMock.mockImplementation(async (url: string) => url.startsWith('/api/panel/prs?') ? list(1) : Response.json({}));
  await act(async () => vi.advanceTimersByTimeAsync(2 * 60_000 + 1)); await settle();
  expect(reads()).toHaveLength(2); expect(values()).toEqual(['1 open']);
  await render([{ anchorRect: null }]);
  await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
  expect(reads()).toHaveLength(2); expect(values()).toEqual([]);
});

it('keeps the known counts after a rate-limited background refresh', async () => {
  await render();
  fetchMock.mockImplementation(async (url: string) => url.startsWith('/api/panel/prs?')
    ? new Response('rate limited', { status: 429 }) : Response.json({}));
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(reads()).toHaveLength(2); expect(values()).toEqual(['2 open·1 awaiting review']);
});

it.each([{}, { prs: null }, { prs: {} }])('retains known PR counts after a malformed successful refresh: %j', async payload => {
  await render();
  fetchMock.mockImplementation(async (url: string) => url.startsWith('/api/panel/prs?')
    ? Response.json(payload) : Response.json({}));
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(reads()).toHaveLength(2);
  expect(values()).toEqual(['2 open·1 awaiting review']);
  expect(client.getQueryState(['gh', 'org/sample', 'prs'])?.status).toBe('error');

  fetchMock.mockImplementation(async (url: string) => url.startsWith('/api/panel/prs?') ? list(1) : Response.json({}));
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(values()).toEqual(['1 open']);
  expect(client.getQueryState(['gh', 'org/sample', 'prs'])?.status).toBe('success');
});

it('accepts valid empty PR lists and stale broker snapshots with error metadata', async () => {
  fetchMock.mockImplementation(async (url: string) => url.startsWith('/api/panel/prs?')
    ? Response.json({ repo: 'org/sample', prs: [{ number: 1, state: 'OPEN' }], stale: true, error: 'Refresh unavailable' })
    : Response.json({}));
  await render(); expect(values()).toEqual(['1 open·1 awaiting review']);
  fetchMock.mockImplementation(async () => Response.json({ repo: 'org/sample', prs: [] }));
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(values()).toEqual(['None open']);
});

it.each(['failure', 'malformed'])('shows unknown rather than zero open PRs after an initial %s', async kind => {
  fetchMock.mockImplementation(async (url: string) => !url.startsWith('/api/panel/prs?') ? Response.json({})
    : kind === 'failure' ? new Response('unavailable', { status: 503 }) : Response.json({ prs: {} }));
  await render();
  expect(values()).toEqual(['—']);
});
