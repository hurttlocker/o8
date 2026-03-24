import 'server-only';

import {
  listGitHubIssues,
  listGitHubPullRequests,
  markGitHubSyncError,
  markGitHubSyncSuccess,
  readGitHubSyncState,
  replaceGitHubIssues,
  replaceGitHubPullRequests,
  upsertGitHubInstallation,
  type GitHubIssueSnapshot,
  type GitHubPullRequestSnapshot,
  type GitHubSyncResource,
} from './store';
import { githubInstallationFetch } from './auth';
import { getGitHubAppConfig } from './env';

const GITHUB_SNAPSHOT_TTL_MS = 5 * 60_000;

function resourcePath(repoFullName: string, resource: GitHubSyncResource) {
  if (resource === 'issues') {
    return `/repos/${repoFullName}/issues?state=open&per_page=20&sort=updated&direction=desc`;
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

async function syncIssues(repoFullName: string) {
  const syncState = readGitHubSyncState(repoFullName, 'issues');
  const etag = syncState?.etag ?? null;
  const { response, installation } = await githubInstallationFetch(repoFullName, resourcePath(repoFullName, 'issues'), {
    headers: etag ? { 'If-None-Match': etag } : undefined,
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

  const payload = JSON.parse(bodyText) as Array<{
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
  }>;

  const issues: GitHubIssueSnapshot[] = payload
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
  markGitHubSyncSuccess(repoFullName, 'issues', response.headers.get('etag'));
}

async function syncPullRequests(repoFullName: string) {
  const syncState = readGitHubSyncState(repoFullName, 'pull_requests');
  const etag = syncState?.etag ?? null;
  const { response, installation } = await githubInstallationFetch(repoFullName, resourcePath(repoFullName, 'pull_requests'), {
    headers: etag ? { 'If-None-Match': etag } : undefined,
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

  const listPayload = JSON.parse(bodyText) as Array<{
    id: number;
    number: number;
    title: string;
    state: string;
    body?: string | null;
    html_url: string;
    created_at: string;
    updated_at: string;
    closed_at?: string | null;
    merged_at?: string | null;
    user?: { login?: string | null } | null;
    head?: { ref?: string | null };
    base?: { ref?: string | null };
  }>;

  const pulls: GitHubPullRequestSnapshot[] = [];

  for (const item of listPayload) {
    const { response: detailResponse } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${item.number}`);
    const detailText = await detailResponse.text();
    if (!detailResponse.ok) {
      throw buildGitHubError(detailResponse, detailText);
    }
    const detail = JSON.parse(detailText) as {
      additions?: number;
      deletions?: number;
      changed_files?: number;
      requested_reviewers?: unknown[];
      html_url: string;
      created_at: string;
      updated_at: string;
      closed_at?: string | null;
      merged_at?: string | null;
    };

    pulls.push({
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
      url: detail.html_url,
      createdAt: detail.created_at,
      updatedAt: detail.updated_at,
      closedAt: detail.closed_at ?? null,
      mergedAt: detail.merged_at ?? null,
    });
  }

  replaceGitHubPullRequests(repoFullName, pulls);
  markGitHubSyncSuccess(repoFullName, 'pull_requests', response.headers.get('etag'));
}

export async function ensureGitHubIssues(repoFullName: string) {
  const config = getGitHubAppConfig();
  const current = listGitHubIssues(repoFullName);
  const syncState = readGitHubSyncState(repoFullName, 'issues');

  if (!config) {
    return {
      issues: current,
      error: current.length > 0 ? null : 'GitHub App is not configured.',
      stale: true,
    };
  }

  if (current.length > 0 && isFresh(syncState?.lastSuccessfulAt)) {
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
  const config = getGitHubAppConfig();
  const current = listGitHubPullRequests(repoFullName);
  const syncState = readGitHubSyncState(repoFullName, 'pull_requests');

  if (!config) {
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
