/**
 * Shared client cache for GitHub-backed lists (#3460).
 *
 * Every surface that shows a repository's pull requests or issues reads the
 * same TanStack Query entry, so N cards or badges for one repository cost one
 * request. The server already keeps a two-minute snapshot per repository
 * (`src/lib/github-broker/sync.ts`); this layer stops each component from
 * paying its own round trip and from showing a different snapshot of the
 * same pull request.
 *
 * Refresh policy:
 *   - a list is fresh for 2 minutes;
 *   - it refreshes every 2 minutes while the window is visible and every
 *     5 minutes while it is hidden or in the tray;
 *   - a manual refresh cancels any background fetch in flight and asks the
 *     server to bypass its snapshot where the route supports it;
 *   - a failed or rate-limited refresh keeps the last data on screen
 *     (TanStack keeps `data` on error; the route reports `stale`).
 */

import type { QueryClient } from '@tanstack/react-query';

export const GITHUB_LIST_FRESH_MS = 2 * 60_000;
export const GITHUB_VISIBLE_REFRESH_MS = 2 * 60_000;
export const GITHUB_HIDDEN_REFRESH_MS = 5 * 60_000;
const GITHUB_LIST_GC_MS = 10 * 60_000;

export type GithubListKind = 'prs' | 'issues';

export interface GithubPullRequestSummary {
  number: number;
  title: string;
  author: string | null;
  headRefName: string;
  baseRefName: string;
  state: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  statusCheckRollup?: unknown;
  reviewDecision?: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface GithubIssueSummary {
  number: number;
  title: string;
  labels: unknown[];
  state: string;
  author: string | null;
  assignees?: unknown[];
  comments?: number;
  body?: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
}

interface GithubListMeta {
  repo: string | null;
  error?: string | null;
  stale?: boolean;
  unavailable?: boolean;
}

export interface GithubPullRequestList extends GithubListMeta {
  prs: GithubPullRequestSummary[];
}

export interface GithubIssueList extends GithubListMeta {
  issues: GithubIssueSummary[];
}

/** Repository slugs are case-insensitive on GitHub, so the key is too. */
export function githubListQueryKey(repo: string, kind: GithubListKind): string[] {
  return ['gh', repo.trim().toLowerCase(), kind];
}

function windowHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

export function githubRefreshInterval(isHidden: () => boolean = windowHidden): () => number {
  return () => (isHidden() ? GITHUB_HIDDEN_REFRESH_MS : GITHUB_VISIBLE_REFRESH_MS);
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json() as Promise<T>;
}

function listUrl(repo: string, kind: GithubListKind, fresh: boolean): string {
  const query = `repo=${encodeURIComponent(repo.trim())}${fresh ? '&fresh=1' : ''}`;
  return kind === 'prs' ? `/api/panel/prs?${query}` : `/api/panel/issues?${query}`;
}

interface ListQueryOptions {
  isHidden?: () => boolean;
}

function listQuery<T>(repo: string, kind: GithubListKind, { isHidden }: ListQueryOptions = {}) {
  return {
    queryKey: githubListQueryKey(repo, kind),
    queryFn: ({ signal }: { signal?: AbortSignal }) => getJson<T>(listUrl(repo, kind, false), signal),
    staleTime: GITHUB_LIST_FRESH_MS,
    gcTime: GITHUB_LIST_GC_MS,
    refetchInterval: githubRefreshInterval(isHidden),
    // A hidden desktop window still refreshes, on the slower interval above.
    refetchIntervalInBackground: true,
  };
}

export function pullRequestListQuery(repo: string, options?: ListQueryOptions) {
  return listQuery<GithubPullRequestList>(repo, 'prs', options);
}

export function issueListQuery(repo: string, options?: ListQueryOptions) {
  return listQuery<GithubIssueList>(repo, 'issues', options);
}

/**
 * A user-triggered refresh. It cancels a background fetch in flight so the
 * click is never answered by an older request, and asks the server to skip
 * its snapshot (the issues route honors `fresh=1`; the pull request route
 * ignores the flag and serves its snapshot, which a webhook keeps current).
 */
export async function refreshGithubList(
  queryClient: QueryClient,
  repo: string,
  kind: GithubListKind,
): Promise<GithubPullRequestList | GithubIssueList> {
  const queryKey = githubListQueryKey(repo, kind);
  await queryClient.cancelQueries({ queryKey });
  return queryClient.fetchQuery({
    queryKey,
    queryFn: ({ signal }) => getJson<GithubPullRequestList | GithubIssueList>(listUrl(repo, kind, true), signal),
    staleTime: 0,
  });
}
