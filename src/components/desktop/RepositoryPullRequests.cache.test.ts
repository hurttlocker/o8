// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PullRequestListItem } from '@/lib/github-broker/pull-request-list.types';
import { pullRequestListQuery } from '@/lib/github-client';
import { RepositoryPullRequests } from './RepositoryPullRequests';

const pull = (number = 1, title = `Change ${number}`): PullRequestListItem => ({ number, title, author: 'fixture', avatarUrl: null,
  additions: 1, deletions: 0, checks: 'success', requestedReviewers: [], draft: false, state: 'open', headRefName: `branch-${number}`,
  baseRefName: 'main', headRepoFullName: 'example/repo', labels: ['bug'], createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z', url: `https://github.com/example/repo/pull/${number}` });
const page = (prs = [pull()], nextPage: number | null = null, repo = 'example/repo', statsUnavailable = false) => Response.json({ prs, nextPage, repo, statsUnavailable });
let client: QueryClient; let root: Root; let host: HTMLDivElement; let fetchMock: ReturnType<typeof vi.fn>;
const reads = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/panel/prs?'));
const rows = () => [...host.querySelectorAll<HTMLButtonElement>('[data-pr-number]')];
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const textButton = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!;
async function settle(ms = 0) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function show(count = 1, repoPath: string | null = '/workspace/repo', active = true) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...Array.from({ length: count }, (_, key) => createElement(RepositoryPullRequests, { key, repoPath, active })),
  ))); await settle(); await settle();
}
async function click(node: HTMLButtonElement) { await act(async () => node.click()); await settle(); await settle(); }
async function choose(label: string, text: string) {
  await click(button(label)); await click([...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(node => node.textContent === text)!);
}
async function updated(repo = 'example/repo') {
  await act(async () => window.dispatchEvent(new CustomEvent('o8:pr-updated', { detail: { repo, number: 1 } })));
  await settle(); await settle();
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock = vi.fn(async (url: string) => url === '/api/panel/github-status' ? Response.json({ authenticated: false }) : page());
  vi.stubGlobal('fetch', fetchMock); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('shares one enriched first-page read across five real repository PR lists', async () => {
  await show(5); expect(rows()).toHaveLength(5); expect(reads()).toHaveLength(1);
  expect(Object.fromEntries(new URL(reads()[0][0], 'http://fixture').searchParams)).toEqual({ repoPath: '/workspace/repo', view: 'list', state: 'open', sort: 'updated', page: '1' });
});
it('reuses fresh loaded pages after remount', async () => {
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/github-status' ? Response.json({ authenticated: false })
    : url.includes('page=2') ? page([pull(2)]) : page([pull(1)], 2));
  await show(); await click(textButton('Load more pull requests')); expect(rows()).toHaveLength(2);
  await show(0); await show(); expect(rows()).toHaveLength(2); expect(reads()).toHaveLength(2);
});
it('shares newly loaded pages with another view and deduplicates repeated load-more clicks', async () => {
  let finish!: () => void;
  fetchMock.mockImplementation((url: string) => url === '/api/panel/github-status' ? Promise.resolve(Response.json({ authenticated: false }))
    : url.includes('page=2') ? new Promise<Response>(resolve => { finish = () => resolve(page([pull(2)])); }) : Promise.resolve(page([pull(1)], 2)));
  await show(2); const more = textButton('Load more pull requests'); await act(async () => { more.click(); more.click(); });
  await act(async () => finish()); await settle(); await settle();
  expect(rows().map(row => row.dataset.prNumber)).toEqual(['1', '2', '1', '2']); expect(reads()).toHaveLength(2);
});
it('keeps different checkouts separate even when both resolve to the same remote', async () => {
  await show(); fetchMock.mockImplementation(async (url: string) => url === '/api/panel/github-status' ? Response.json({ authenticated: false }) : page([pull(8)]));
  await show(1, '/workspace/second'); expect(rows()[0].dataset.prNumber).toBe('8'); expect(reads()).toHaveLength(2);
});
it('reuses independently cached state pages, including the closed page behind the merged filter', async () => {
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/github-status' ? Response.json({ authenticated: false })
    : url.includes('state=closed') ? page([{ ...pull(2), state: 'closed' }, { ...pull(3), state: 'merged' }]) : page());
  await show(); await choose('Pull request state', 'Closed'); expect(rows().map(row => row.dataset.prNumber)).toEqual(['2']);
  await choose('Pull request state', 'Merged'); expect(rows().map(row => row.dataset.prNumber)).toEqual(['3']); expect(reads()).toHaveLength(2);
  await choose('Pull request state', 'Open'); expect(rows()[0].dataset.prNumber).toBe('1'); expect(reads()).toHaveLength(2);
});
it('keeps sort snapshots separate and reuses them when switching back', async () => {
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/github-status' ? Response.json({ authenticated: false })
    : page([pull(url.includes('sort=oldest') ? 2 : 1)]));
  await show(); await choose('Sort pull requests', 'Oldest'); expect(rows()[0].dataset.prNumber).toBe('2');
  await choose('Sort pull requests', 'Updated'); expect(rows()[0].dataset.prNumber).toBe('1'); expect(reads()).toHaveLength(2);
});
it('suppresses initial reads without an active checkout', async () => {
  await show(1, null); await show(1, '/workspace/repo', false); expect(reads()).toHaveLength(0);
  await show(); expect(reads()).toHaveLength(1);
});
it('isolates delayed replies and navigation after a repository switch', async () => {
  let finish!: () => void;
  fetchMock.mockImplementation((url: string) => url === '/api/panel/github-status' ? Promise.resolve(Response.json({ authenticated: false }))
    : url.includes('repoPath=%2Fworkspace%2Frepo') ? new Promise<Response>(resolve => { finish = () => resolve(page()); })
      : Promise.resolve(page([pull(9)], null, 'example/other')));
  await show(); const oldSignal = reads()[0][1].signal; await show(1, '/workspace/other');
  await act(async () => finish()); await settle(); expect(oldSignal.aborted).toBe(true); expect(rows()[0].dataset.prNumber).toBe('9');
  const opened = vi.fn(); window.addEventListener('o8:open-pr', opened);
  try { await click(rows()[0]); expect(opened.mock.calls[0][0].detail).toEqual({ prNumber: 9, repo: 'example/other', repoPath: '/workspace/other' }); }
  finally { window.removeEventListener('o8:open-pr', opened); }
});
it('clears previous-scope rows while the next checkout is pending', async () => {
  await show(); fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
  await show(1, '/workspace/other'); expect(rows()).toHaveLength(0);
});
it('refreshes visible lists every two minutes and stops after unmount', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); await show();
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/github-status' ? Response.json({ authenticated: false }) : page([pull(2)]));
  await settle(2 * 60_000 + 1); await settle(); expect(rows()[0].dataset.prNumber).toBe('2'); expect(reads()).toHaveLength(2);
  await show(0); await settle(5 * 60_000); expect(reads()).toHaveLength(2);
});
it('uses the shared five-minute interval while hidden', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); await show();
  await settle(2 * 60_000 + 1); expect(reads()).toHaveLength(1);
  await settle(3 * 60_000); expect(reads()).toHaveLength(2);
});
it('cancels an in-flight page when the final active list is hidden', async () => {
  let finish!: () => void;
  fetchMock.mockImplementation((url: string) => url === '/api/panel/github-status' ? Promise.resolve(Response.json({ authenticated: false }))
    : new Promise<Response>(resolve => { finish = () => resolve(page()); }));
  await show(); const signal = reads()[0][1].signal; await show(1, '/workspace/repo', false);
  expect(signal.aborted).toBe(true); await act(async () => finish()); await settle(); expect(rows()).toHaveLength(0);
});
it('keeps a shared pending read alive while another list is still active', async () => {
  let finish!: () => void;
  fetchMock.mockImplementation((url: string) => url === '/api/panel/github-status' ? Promise.resolve(Response.json({ authenticated: false }))
    : new Promise<Response>(resolve => { finish = () => resolve(page()); }));
  await show(2); const signal = reads()[0][1].signal;
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...[false, true].map((active, key) => createElement(RepositoryPullRequests, { key, repoPath: '/workspace/repo', active })),
  ))); await settle();
  expect(signal.aborted).toBe(false); await act(async () => finish()); await settle(); await settle();
  expect(rows().some(row => row.dataset.prNumber === '1')).toBe(true); expect(reads()).toHaveLength(1);
});
it('keeps known rows after a failed manual refresh and retries through the real control', async () => {
  await show(); fetchMock.mockImplementation(async () => new Response('limited', { status: 429 }));
  await click(button('Refresh pull requests')); expect(rows()).toHaveLength(1); expect(host.querySelector('[role="alert"]')).not.toBeNull();
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/github-status' ? Response.json({ authenticated: false }) : page([pull(2)]));
  await click(textButton('Retry')); expect(rows()[0].dataset.prNumber).toBe('2'); expect(host.querySelector('[role="alert"]')).toBeNull();
});
it('retries an initial failure without losing the selected checkout', async () => {
  fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 })); await show();
  expect(rows()).toHaveLength(0); await click(textButton('Retry')); expect(rows()).toHaveLength(1);
  expect(reads().every(([url]) => String(url).includes('repoPath=%2Fworkspace%2Frepo'))).toBe(true);
});
it('deduplicates pagination rows and preserves partial-stat warnings', async () => {
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/github-status' ? Response.json({ authenticated: false })
    : url.includes('page=2') ? page([pull(1, 'Repeated'), pull(2)]) : page([pull()], 2, 'example/repo', true));
  await show(); await click(textButton('Load more pull requests'));
  expect(rows().map(row => row.dataset.prNumber)).toEqual(['1', '2']); expect(rows()[0].textContent).not.toContain('Repeated');
  expect(host.textContent).toContain('Some diff totals'); expect(textButton('Load more pull requests')).toBeUndefined();
});
it('retries a failed next page while retaining the first page', async () => {
  let failed = true;
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/github-status' ? Response.json({ authenticated: false })
    : url.includes('page=2') ? failed ? new Response('unavailable', { status: 503 }) : page([pull(2)]) : page([pull()], 2));
  await show(); await click(textButton('Load more pull requests')); expect(rows()).toHaveLength(1);
  failed = false; await click(textButton('Retry')); expect(rows()).toHaveLength(2); expect(reads().at(-1)?.[0]).toContain('page=2');
});
it('revalidates all loaded pages during a background refresh', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); let fresh = false;
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/github-status' ? Response.json({ authenticated: false })
    : url.includes('page=2') ? page([pull(2, fresh ? 'Fresh second page' : 'Older second page')]) : page([pull(1, fresh ? 'Fresh first page' : 'Older first page')], 2));
  await show(); await click(textButton('Load more pull requests')); fresh = true;
  await settle(2 * 60_000 + 1); await settle(); expect(rows()).toHaveLength(2);
  expect(host.textContent).toContain('Fresh first page'); expect(host.textContent).toContain('Fresh second page'); expect(reads()).toHaveLength(4);
});
it('keeps loaded pagination intact during a manual refresh', async () => {
  let fresh = false;
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/github-status' ? Response.json({ authenticated: false })
    : url.includes('page=2') ? page([pull(2, fresh ? 'Fresh second page' : 'Older second page')]) : page([pull(1)], 2));
  await show(); await click(textButton('Load more pull requests')); fresh = true; await click(button('Refresh pull requests'));
  expect(rows()).toHaveLength(2); expect(host.textContent).toContain('Fresh second page'); expect(reads()).toHaveLength(4);
});
it('invalidates other cached state variants after a matching write', async () => {
  let fresh = false;
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/github-status' ? Response.json({ authenticated: false })
    : url.includes('state=closed') ? page([{ ...pull(2, fresh ? 'Fresh closed row' : 'Older closed row'), state: 'closed' }]) : page());
  await show(); await choose('Pull request state', 'Closed'); await choose('Pull request state', 'Open');
  fresh = true; await updated(); await choose('Pull request state', 'Closed');
  expect(host.textContent).toContain('Fresh closed row');
});
it('shares a matching post-write refresh across views and ignores other repositories', async () => {
  await show(5); const before = reads().length; await updated('example/other'); expect(reads()).toHaveLength(before);
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/github-status' ? Response.json({ authenticated: false }) : page([pull(2)]));
  await updated(); expect(rows().every(row => row.dataset.prNumber === '2')).toBe(true); expect(reads()).toHaveLength(before + 1);
});
it('defers matching post-write invalidation while inactive and refetches on activation', async () => {
  await show(); await show(1, '/workspace/repo', false); await updated(); expect(reads()).toHaveLength(1);
  await settle(5 * 60_000); expect(reads()).toHaveLength(1); await show(); expect(reads()).toHaveLength(2);
});
it('supersedes an older pending read when another matching write arrives', async () => {
  await show(); let finish!: () => void;
  fetchMock.mockImplementation((url: string) => url === '/api/panel/github-status' ? Promise.resolve(Response.json({ authenticated: false }))
    : new Promise<Response>(resolve => { finish = () => resolve(page([pull(3, 'Older reply')])); }));
  await updated(); const oldSignal = reads().at(-1)?.[1].signal;
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/github-status' ? Response.json({ authenticated: false }) : page([pull(2, 'Fresh reply')]));
  await updated(); expect(oldSignal.aborted).toBe(true); await act(async () => finish()); await settle();
  expect(host.textContent).toContain('Fresh reply'); expect(host.textContent).not.toContain('Older reply');
});
it('keeps enriched checkout pages separate from compact summary snapshots', async () => {
  client.setQueryData(pullRequestListQuery('example/repo').queryKey, { repo: 'example/repo', prs: [] });
  await show(); expect(rows()).toHaveLength(1); expect(reads()).toHaveLength(1);
});
