// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { pullRequestListQuery } from '@/lib/github-client';
import { LinkedPullRequests } from './LinkedPullRequests';
import { readLinkedPullRequests, saveLinkedPullRequests } from './linked-pr-store';

const repos = [
  { id: 'repo', name: 'Repo', localPath: '/workspace/repo', remoteUrl: 'https://github.com/example/repo.git' },
  { id: 'other', name: 'Other', localPath: '/workspace/other', remoteUrl: 'https://github.com/example/other.git' },
] as RepoRegistryEntry[];
const pull = (number: number, headRefName: string, baseRefName = 'main', repo = 'example/repo') => ({
  number, title: `Pull ${number}`, headRefName, baseRefName, headRepoFullName: repo, author: 'fixture',
  state: 'open', labels: [], additions: 1, deletions: 0, updatedAt: '2026-10-01T00:00:00Z',
});
const page = (repo = 'example/repo', branch = 'child', nextPage: number | null = null) => Response.json({
  repo, nextPage, prs: [pull(17, 'parent', 'main', repo), pull(18, branch, 'parent', repo)],
});
function save(context = 'tab:fixture:0', repo = 'example/repo', number = 17, title = 'Saved primary') {
  saveLinkedPullRequests(context, [{ repo, number, title, linkedAt: '2026-10-01T00:00:00Z' }]);
}
let client: QueryClient; let root: Root; let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>; let onOpen: Mock<(number: number, repo: string) => void>;
async function settle(ms = 0) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function show(count = 1, { active = true, repoPath = repos[0].localPath, context = 'tab:fixture' }: { active?: boolean; repoPath?: string | null; context?: string } = {}) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...Array.from({ length: count }, (_, key) => createElement(LinkedPullRequests, {
      key, context: `${context}:${key}`, tabId: `${context}:${key}`, repoPath, repos, active, onOpen,
    })),
  ))); await settle(); await settle();
}
async function expand() {
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click());
}
const dependencies = () => [...host.querySelectorAll('button')].filter(button => button.textContent?.includes(' · parent') || button.textContent?.includes(' · child'));
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (let index = 0; index < 5; index++) save(`tab:fixture:${index}`);
  onOpen = vi.fn<(number: number, repo: string) => void>(); fetchMock = vi.fn(async () => page()); vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('shares one enriched list read across five real linked-PR views', async () => {
  await show(5); expect(host.textContent?.match(/Saved primary/g)).toHaveLength(5);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const url = new URL(fetchMock.mock.calls[0][0], 'http://fixture');
  expect(Object.fromEntries(url.searchParams)).toEqual({ repo: 'example/repo', view: 'list', state: 'open', page: '1' });
});
it('reuses a fresh dependency snapshot on remount', async () => {
  await show(); await show(0); await show(); await expand();
  expect(dependencies()).toHaveLength(2); expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('keeps enriched pages separate from compact PR summary cache entries', async () => {
  client.setQueryData(pullRequestListQuery('example/repo').queryKey, { repo: 'example/repo', prs: [] });
  await show(); await expand(); expect(dependencies()).toHaveLength(2); expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('suppresses reads while inactive, unbound, or without a saved link for the selected repository', async () => {
  await show(1, { active: false }); await show(1, { repoPath: null }); await show(1, { repoPath: repos[1].localPath });
  expect(fetchMock).not.toHaveBeenCalled(); await show(); expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('reuses the snapshot when saved link metadata changes', async () => {
  await show(); await act(async () => save('tab:fixture:0', 'example/repo', 17, 'Updated saved title')); await settle();
  expect(host.textContent).toContain('Updated saved title'); expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('persists unlinking without refetching the remaining link dependencies', async () => {
  saveLinkedPullRequests('tab:fixture:0', [17, 18].map(number => ({ repo: 'example/repo', number, title: `Saved ${number}`, linkedAt: '2026-10-01T00:00:00Z' })));
  await show(); await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Unlink PR #18 in example/repo"]')!.click()); await settle();
  expect(readLinkedPullRequests('tab:fixture:0').map(entry => entry.number)).toEqual([17]);
  await expand(); expect(dependencies()).toHaveLength(2); expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('isolates repository switches and late replies without losing saved links', async () => {
  saveLinkedPullRequests('tab:fixture:0', ['example/repo', 'example/other'].map(repo => ({ repo, number: 17, title: repo, linkedAt: '2026-10-01T00:00:00Z' })));
  let release!: () => void;
  fetchMock.mockImplementation((url: string) => url.includes('example%2Frepo')
    ? new Promise<Response>(resolve => { release = () => resolve(page()); }) : Promise.resolve(page('example/other', 'other-child')));
  await show(); const oldSignal = fetchMock.mock.calls[0][1].signal;
  await show(1, { repoPath: repos[1].localPath }); await expand();
  expect(host.textContent).toContain('other-child'); expect(oldSignal.aborted).toBe(true);
  await act(async () => release()); await settle(); expect(host.textContent).toContain('other-child');
  await act(async () => dependencies()[0].click()); expect(onOpen).toHaveBeenCalledWith(17, 'example/other');
  expect(readLinkedPullRequests('tab:fixture:0')).toHaveLength(2);
});
it('hides previous-repository dependency rows while the new scope is pending', async () => {
  await show(); await expand(); expect(dependencies()).toHaveLength(2);
  save('tab:other:0', 'example/other');
  fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
  await show(1, { repoPath: repos[1].localPath, context: 'tab:other' }); expect(dependencies()).toHaveLength(0);
  expect(host.textContent).toContain('Saved primary');
});
it('refreshes visible dependencies after two minutes', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); await show(); await expand();
  fetchMock.mockImplementation(async () => page('example/repo', 'child-updated'));
  await settle(2 * 60_000 + 1); await settle();
  expect(host.textContent).toContain('child-updated'); expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('uses the five-minute policy while hidden', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); await show();
  await settle(2 * 60_000 + 1); expect(fetchMock).toHaveBeenCalledTimes(1);
  await settle(3 * 60_000); expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('stops polling when inactive and after unmount', async () => {
  await show(); await show(1, { active: false }); await settle(5 * 60_000); expect(fetchMock).toHaveBeenCalledTimes(1);
  await show(0); await settle(5 * 60_000); expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('retains known dependencies and saved links after a rate-limited refresh, then recovers', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); await show(); await expand();
  fetchMock.mockImplementation(async () => new Response('limited', { status: 429 }));
  await settle(2 * 60_000 + 1); await settle();
  expect(dependencies()).toHaveLength(2); expect(host.querySelector('[role="status"]')?.textContent).toContain('saved links');
  expect(readLinkedPullRequests('tab:fixture:0')).toHaveLength(1);
  fetchMock.mockImplementation(async () => page('example/repo', 'child-recovered'));
  await settle(2 * 60_000 + 1); await settle();
  expect(host.textContent).toContain('child-recovered'); expect(host.querySelector('[role="status"]')).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
it('retries an initial failure on the shared interval', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 })); await show(); await expand();
  expect(host.textContent).toContain('Saved primary'); expect(host.querySelector('[role="status"]')).not.toBeNull();
  await settle(2 * 60_000 + 1); await settle(); expect(dependencies()).toHaveLength(2);
  expect(host.querySelector('[role="status"]')).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('rejects a response for a different repository while retaining saved links', async () => {
  fetchMock.mockImplementation(async () => page('example/other')); await show(); await expand();
  expect(dependencies()).toHaveLength(0); expect(host.querySelector('[role="status"]')).not.toBeNull();
  expect(readLinkedPullRequests('tab:fixture:0')).toHaveLength(1);
});
it('preserves partial-page dependency navigation without fetching additional pages or changing saved links', async () => {
  fetchMock.mockImplementation(async () => Response.json({ repo: 'example/repo', nextPage: 2,
    prs: [pull(17, 'parent'), pull(18, 'child', 'parent'), pull(44, 'unrelated'), pull(45, 'fork-parent', 'main', 'fork/repo'), pull(46, 'fork-child', 'fork-parent')] }));
  await show(); await expand(); expect(host.textContent).toContain('partial list');
  expect(host.textContent).not.toContain('unrelated'); expect(host.textContent).not.toContain('fork-child');
  await act(async () => dependencies()[1].click()); expect(onOpen).toHaveBeenCalledWith(18, 'example/repo');
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(readLinkedPullRequests('tab:fixture:0').map(entry => entry.number)).toEqual([17]);
});
it('reuses the same remote page across conversations while deriving each conversation graph from its own links', async () => {
  save('tab:second:0', 'example/repo', 44, 'Second saved link');
  fetchMock.mockImplementation(async () => Response.json({ repo: 'example/repo', nextPage: null,
    prs: [pull(17, 'parent'), pull(18, 'child', 'parent'), pull(44, 'second-parent'), pull(45, 'second-child', 'second-parent')] }));
  await show(); await expand(); expect(host.textContent).toContain('#18 · child'); expect(host.textContent).not.toContain('second-child');
  await show(1, { context: 'tab:second' }); expect(host.textContent).toContain('second-child'); expect(host.textContent).not.toContain('#18 · child');
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(readLinkedPullRequests('tab:fixture:0').map(entry => entry.number)).toEqual([17]);
});
