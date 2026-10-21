// @vitest-environment jsdom
/**
 * Shared GitHub list cache (#3460), driven through a real TanStack
 * QueryClient with the same options the hooks pass to `useQuery`.
 */
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GITHUB_HIDDEN_REFRESH_MS,
  GITHUB_LIST_FRESH_MS,
  GITHUB_VISIBLE_REFRESH_MS,
  githubListQueryKey,
  githubRefreshInterval,
  issueListQuery,
  pullRequestListQuery,
  refreshGithubList,
} from './queries';

function listResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;
let client: QueryClient;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => listResponse({ repo: 'o/r', prs: [], issues: [], url }));
  vi.stubGlobal('fetch', fetchMock);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('shared GitHub list cache', () => {
  it('serves many readers of one repository from one request', async () => {
    const readers = Array.from({ length: 10 }, (_, index) =>
      client.fetchQuery(pullRequestListQuery(index % 2 ? 'Owner/Repo' : 'owner/repo')),
    );
    await Promise.all(readers);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/panel/prs?repo=owner%2Frepo');
  });

  it('keeps pull requests and issues for the same repository apart', async () => {
    await client.fetchQuery(pullRequestListQuery('owner/repo'));
    await client.fetchQuery(issueListQuery('owner/repo'));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/panel/prs?repo=owner%2Frepo',
      '/api/panel/issues?repo=owner%2Frepo',
    ]);
  });

  it('reuses a list for two minutes, then fetches again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    await client.fetchQuery(pullRequestListQuery('owner/repo'));
    vi.setSystemTime(Date.now() + GITHUB_LIST_FRESH_MS - 1_000);
    await client.fetchQuery(pullRequestListQuery('owner/repo'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2_000);
    await client.fetchQuery(pullRequestListQuery('owner/repo'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes every two minutes while visible and every five while hidden', () => {
    let hidden = false;
    const interval = githubRefreshInterval(() => hidden);
    expect(interval()).toBe(GITHUB_VISIBLE_REFRESH_MS);
    hidden = true;
    expect(interval()).toBe(GITHUB_HIDDEN_REFRESH_MS);
    expect(pullRequestListQuery('owner/repo').refetchIntervalInBackground).toBe(true);
  });

  it('polls a watched list on the hidden interval while the window is hidden', async () => {
    vi.useFakeTimers();
    const observer = new QueryObserver(client, pullRequestListQuery('owner/repo', { isHidden: () => true }));
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(GITHUB_VISIBLE_REFRESH_MS + 1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(GITHUB_HIDDEN_REFRESH_MS - GITHUB_VISIBLE_REFRESH_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('lets a manual refresh cancel a background fetch and ask the server for fresh data', async () => {
    let releaseBackground: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => new Promise<Response>((resolve, reject) => {
      releaseBackground = resolve;
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    fetchMock.mockImplementationOnce(async () => listResponse({ repo: 'owner/repo', issues: [{ number: 7 }] }));

    const background = client.fetchQuery(issueListQuery('owner/repo')).catch(() => null);
    await Promise.resolve();
    const manual = await refreshGithubList(client, 'owner/repo', 'issues');
    releaseBackground(listResponse({ repo: 'owner/repo', issues: [{ number: 1 }] }));
    await background;

    expect(fetchMock.mock.calls[1][0]).toBe('/api/panel/issues?repo=owner%2Frepo&fresh=1');
    expect(manual).toEqual({ repo: 'owner/repo', issues: [{ number: 7 }] });
    expect(client.getQueryData(githubListQueryKey('owner/repo', 'issues'))).toEqual(manual);
  });

  it('keeps the last list on screen when a refresh fails', async () => {
    await client.fetchQuery(pullRequestListQuery('owner/repo'));
    fetchMock.mockImplementationOnce(async () => new Response('rate limited', { status: 403 }));
    await expect(refreshGithubList(client, 'owner/repo', 'prs')).rejects.toThrow('403');
    expect(client.getQueryData(githubListQueryKey('owner/repo', 'prs'))).toMatchObject({ repo: 'o/r' });
  });
});
