import 'server-only';

import {
  getGitHubPullRequestByHead,
  getGitHubPullRequestByNumber,
  listGitHubIssues,
  listGitHubPullRequests,
  markGitHubSyncError,
  markGitHubSyncSuccess,
  readGitHubSyncState,
  replaceGitHubIssues,
  replaceGitHubPullRequests,
  upsertGitHubPullRequest,
  upsertGitHubInstallation,
  type GitHubIssueSnapshot,
  type GitHubPullRequestSnapshot,
  type GitHubSyncResource,
} from './store';
import { githubInstallationFetch } from './auth';
import { hasGitHubBrokerAccess } from './auth';

const GITHUB_SNAPSHOT_TTL_MS = 120_000; // 2 min — balance freshness with rate limit budget

const MAX_ISSUE_PAGES = 5; // 5 pages * 100 = 500 issues max

function resourcePath(repoFullName: string, resource: GitHubSyncResource, page = 1) {
  if (resource === 'issues') {
    return `/repos/${repoFullName}/issues?state=open&per_page=100&sort=updated&direction=desc&page=${page}`;
  }
  return `/repos/${repoFullName}/pulls?state=open&per_page=20&sort=updated&direction=desc`;
}

function isFresh(lastSuccessfulAt?: string | null) {
  if (!lastSuccessfulAt) return false;
  return (Date.now() - new Date(lastSuccessfulAt).getTime()) < GITHUB_SNAPSHOT_TTL_MS;
}

function buildGitHubError(response: Response, bodyText: string) {
  const reset = response.headers.get('x-ratelimit-reset');
  const retryAfter = response.headers.get('retry-after');
  const remaining = response.headers.get('x-ratelimit-remaining');
  const parts = [`GitHub request failed (${response.status})`];
  if (bodyText) parts.push(bodyText.trim());
  if (remaining) parts.push(`remaining=${remaining}`);
  if (retryAfter) parts.push(`retryAfter=${retryAfter}s`);
  if (reset) parts.push(`resetAt=${new Date(Number(reset) * 1000).toISOString()}`);
  return new Error(parts.join(' · '));
}

type GitHubIssuePayloadItem = {
  id: number;
  number: number;
  title: string;
  state: string;
  body?: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  user?: { login?: string | null } | null;
  assignees?: Array<{ login?: string | null }>;
  labels?: Array<{ name?: string | null; color?: string | null }>;
  comments?: number;
  pull_request?: unknown;
  repository_url?: string;
};

type GitHubPullRequestPayload = {
  id: number;
  number: number;
  title: string;
  state: string;
  body?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  merged_at?: string | null;
  user?: { login?: string | null } | null;
  head?: { ref?: string | null };
  base?: { ref?: string | null };
  additions?: number;
  deletions?: number;
  changed_files?: number;
};

function mapPullRequestSnapshot(
  repoFullName: string,
  item: GitHubPullRequestPayload,
  detail: GitHubPullRequestPayload,
): GitHubPullRequestSnapshot {
  return {
    pullRequestId: item.id,
    repoFullName,
    number: item.number,
    title: item.title,
    state: item.state,
    author: item.user?.login ? { login: item.user.login } : null,
    body: item.body ?? '',
    headRefName: item.head?.ref ?? '',
    baseRefName: item.base?.ref ?? '',
    additions: detail.additions ?? 0,
    deletions: detail.deletions ?? 0,
    changedFiles: detail.changed_files ?? 0,
    reviewDecision: null,
    statusCheckRollup: [],
    url: detail.html_url ?? item.html_url ?? '',
    createdAt: detail.created_at ?? item.created_at ?? '',
    updatedAt: detail.updated_at ?? item.updated_at ?? item.created_at ?? '',
    closedAt: detail.closed_at ?? item.closed_at ?? null,
    mergedAt: detail.merged_at ?? item.merged_at ?? null,
  };
}

async function syncIssues(repoFullName: string) {
  const syncState = readGitHubSyncState(repoFullName, 'issues');
  const etag = syncState?.etag ?? null;
  // Skip ETag when TTL has expired — forces a fresh fetch so pagination runs
  const useEtag = etag && isFresh(syncState?.lastSuccessfulAt);

  // Fetch page 1 (with ETag for cache validation)
  const { response, installation } = await githubInstallationFetch(repoFullName, resourcePath(repoFullName, 'issues', 1), {
    headers: useEtag ? { 'If-None-Match': etag } : undefined,
  });

  upsertGitHubInstallation({
    installationId: installation.id,
    accountLogin: installation.account?.login ?? repoFullName.split('/')[0],
    accountType: installation.account?.type ?? null,
    targetType: installation.target_type ?? null,
    permissions: installation.permissions ?? null,
  });

  if (response.status === 304) {
    markGitHubSyncSuccess(repoFullName, 'issues', etag);
    return;
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw buildGitHubError(response, bodyText);
  }

  const firstPage = JSON.parse(bodyText) as GitHubIssuePayloadItem[];
  const allItems: GitHubIssuePayloadItem[] = [...firstPage];
  const lastEtag = response.headers.get('etag');

  // Paginate if first page was full (may have more)
  if (firstPage.length >= 100) {
    for (let page = 2; page <= MAX_ISSUE_PAGES; page++) {
      const { response: pageResponse } = await githubInstallationFetch(
        repoFullName,
        resourcePath(repoFullName, 'issues', page),
      );
      const pageText = await pageResponse.text();
      if (!pageResponse.ok) {
        console.warn(`[github-broker] Issues page ${page} failed (${pageResponse.status}), stopping pagination`);
        break;
      }
      const pageItems = JSON.parse(pageText) as GitHubIssuePayloadItem[];
      allItems.push(...pageItems);
      if (pageItems.length < 100) break; // last page
    }
  }

  const issues: GitHubIssueSnapshot[] = allItems
    .filter((item) => !item.pull_request)
    .map((issue) => ({
      issueId: issue.id,
      repoFullName,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      author: issue.user?.login ? { login: issue.user.login } : null,
      assignees: (issue.assignees ?? [])
        .map((assignee) => assignee.login ? { login: assignee.login } : null)
        .filter((assignee): assignee is { login: string } => Boolean(assignee)),
      labels: (issue.labels ?? [])
        .map((label) => label.name ? { name: label.name, color: label.color ?? '000000' } : null)
        .filter((label): label is { name: string; color: string } => Boolean(label)),
      comments: issue.comments ?? 0,
      body: issue.body ?? '',
      url: issue.html_url,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at ?? null,
    }));

  replaceGitHubIssues(repoFullName, issues);
  markGitHubSyncSuccess(repoFullName, 'issues', lastEtag);
}

async function syncPullRequests(repoFullName: string) {
  const syncState = readGitHubSyncState(repoFullName, 'pull_requests');
  const etag = syncState?.etag ?? null;
  const useEtag = etag && isFresh(syncState?.lastSuccessfulAt);
  const { response, installation } = await githubInstallationFetch(repoFullName, resourcePath(repoFullName, 'pull_requests'), {
    headers: useEtag ? { 'If-None-Match': etag } : undefined,
  });

  upsertGitHubInstallation({
    installationId: installation.id,
    accountLogin: installation.account?.login ?? repoFullName.split('/')[0],
    accountType: installation.account?.type ?? null,
    targetType: installation.target_type ?? null,
    permissions: installation.permissions ?? null,
  });

  if (response.status === 304) {
    markGitHubSyncSuccess(repoFullName, 'pull_requests', etag);
    return;
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw buildGitHubError(response, bodyText);
  }

  const listPayload = JSON.parse(bodyText) as GitHubPullRequestPayload[];

  const pulls: GitHubPullRequestSnapshot[] = [];

  for (const item of listPayload) {
    const { response: detailResponse } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${item.number}`);
    const detailText = await detailResponse.text();
    if (!detailResponse.ok) {
      throw buildGitHubError(detailResponse, detailText);
    }
    const detail = JSON.parse(detailText) as GitHubPullRequestPayload;
    pulls.push(mapPullRequestSnapshot(repoFullName, item, detail));
  }

  replaceGitHubPullRequests(repoFullName, pulls);
  markGitHubSyncSuccess(repoFullName, 'pull_requests', response.headers.get('etag'));
}

async function syncPullRequest(repoFullName: string, prNumber: number) {
  const { response, installation } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}`);

  upsertGitHubInstallation({
    installationId: installation.id,
    accountLogin: installation.account?.login ?? repoFullName.split('/')[0],
    accountType: installation.account?.type ?? null,
    targetType: installation.target_type ?? null,
    permissions: installation.permissions ?? null,
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw buildGitHubError(response, bodyText);
  }

  const detail = JSON.parse(bodyText) as GitHubPullRequestPayload;
  const pull = mapPullRequestSnapshot(repoFullName, detail, detail);
  upsertGitHubPullRequest(pull);
  return pull;
}

async function syncPullRequestByHead(repoFullName: string, headRefName: string) {
  const owner = repoFullName.split('/')[0] ?? '';
  const head = encodeURIComponent(`${owner}:${headRefName}`);
  const { response, installation } = await githubInstallationFetch(
    repoFullName,
    `/repos/${repoFullName}/pulls?state=all&head=${head}&per_page=1&sort=updated&direction=desc`,
  );

  upsertGitHubInstallation({
    installationId: installation.id,
    accountLogin: installation.account?.login ?? owner,
    accountType: installation.account?.type ?? null,
    targetType: installation.target_type ?? null,
    permissions: installation.permissions ?? null,
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw buildGitHubError(response, bodyText);
  }

  const pulls = JSON.parse(bodyText) as GitHubPullRequestPayload[];
  const match = pulls[0];
  if (!match) return null;

  const pull = mapPullRequestSnapshot(repoFullName, match, match);
  upsertGitHubPullRequest(pull);
  return pull;
}

export async function ensureGitHubIssues(repoFullName: string, options?: { fresh?: boolean }) {
  const current = listGitHubIssues(repoFullName);
  const syncState = readGitHubSyncState(repoFullName, 'issues');

  if (!hasGitHubBrokerAccess()) {
    return {
      issues: current,
      error: current.length > 0 ? null : 'GitHub App is not configured.',
      stale: true,
    };
  }

  if (!options?.fresh && current.length > 0 && isFresh(syncState?.lastSuccessfulAt)) {
    return { issues: current, error: syncState?.lastError ?? null, stale: false };
  }

  try {
    await syncIssues(repoFullName);
  } catch (error) {
    markGitHubSyncError(repoFullName, 'issues', error instanceof Error ? error.message : 'Unable to sync GitHub issues');
  }

  const refreshed = listGitHubIssues(repoFullName);
  const nextState = readGitHubSyncState(repoFullName, 'issues');
  return {
    issues: refreshed,
    error: nextState?.lastError ?? null,
    stale: !isFresh(nextState?.lastSuccessfulAt),
  };
}

export async function ensureGitHubPullRequests(repoFullName: string) {
  const current = listGitHubPullRequests(repoFullName);
  const syncState = readGitHubSyncState(repoFullName, 'pull_requests');

  if (!hasGitHubBrokerAccess()) {
    return {
      prs: current,
      error: current.length > 0 ? null : 'GitHub App is not configured.',
      stale: true,
    };
  }

  if (current.length > 0 && isFresh(syncState?.lastSuccessfulAt)) {
    return { prs: current, error: syncState?.lastError ?? null, stale: false };
  }

  try {
    await syncPullRequests(repoFullName);
  } catch (error) {
    markGitHubSyncError(repoFullName, 'pull_requests', error instanceof Error ? error.message : 'Unable to sync GitHub pull requests');
  }

  const refreshed = listGitHubPullRequests(repoFullName);
  const nextState = readGitHubSyncState(repoFullName, 'pull_requests');
  return {
    prs: refreshed,
    error: nextState?.lastError ?? null,
    stale: !isFresh(nextState?.lastSuccessfulAt),
  };
}

export async function ensureGitHubPullRequest(repoFullName: string, prNumber: number) {
  const current = getGitHubPullRequestByNumber(repoFullName, prNumber);

  if (!hasGitHubBrokerAccess()) {
    return {
      pr: current,
      error: current ? null : 'GitHub App is not configured.',
      stale: true,
    };
  }

  try {
    const pr = await syncPullRequest(repoFullName, prNumber);
    return { pr, error: null, stale: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to sync GitHub pull request';
    markGitHubSyncError(repoFullName, 'pull_requests', message);
    return { pr: current, error: message, stale: true };
  }
}

export async function ensureGitHubPullRequestByHead(repoFullName: string, headRefName: string) {
  const current = getGitHubPullRequestByHead(repoFullName, headRefName);

  if (!hasGitHubBrokerAccess()) {
    return {
      pr: current,
      error: current ? null : 'GitHub App is not configured.',
      stale: true,
    };
  }

  try {
    const pr = await syncPullRequestByHead(repoFullName, headRefName);
    return { pr: pr ?? current, error: null, stale: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to sync GitHub pull request by head branch';
    markGitHubSyncError(repoFullName, 'pull_requests', message);
    return { pr: current, error: message, stale: true };
  }
}
