import 'server-only';

import { githubInstallationFetch } from './auth';

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAYS_MS = [250, 750];

export type GitHubPullRequestReviewThreadStatus = 'active' | 'outdated' | 'resolved';

export interface GitHubPullRequestReviewThreadComment {
  id: string;
  databaseId: number | null;
  author: string;
  body: string;
  createdAt: string;
  diffHunk: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  url: string;
}

export interface GitHubPullRequestReviewThread {
  id: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  diffSide: string;
  startDiffSide: string | null;
  isResolved: boolean;
  isOutdated: boolean;
  isCollapsed: boolean;
  status: GitHubPullRequestReviewThreadStatus;
  subjectType: string;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  resolvedBy: string | null;
  latestCommentAt: string;
  comments: GitHubPullRequestReviewThreadComment[];
}

class GitHubRequestError extends Error {
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(message: string, options?: { status?: number | null; retryAfterMs?: number | null }) {
    super(message);
    this.name = 'GitHubRequestError';
    this.status = options?.status ?? null;
    this.retryAfterMs = options?.retryAfterMs ?? null;
  }
}

interface GitHubGraphQLResponse<T> {
  data?: T | null;
  errors?: Array<{ message?: string | null }>;
}

interface PullRequestReviewThreadGraphQLNode {
  id: string;
  path: string;
  line?: number | null;
  originalLine?: number | null;
  startLine?: number | null;
  originalStartLine?: number | null;
  diffSide?: string | null;
  startDiffSide?: string | null;
  isResolved?: boolean | null;
  isOutdated?: boolean | null;
  isCollapsed?: boolean | null;
  subjectType?: string | null;
  viewerCanReply?: boolean | null;
  viewerCanResolve?: boolean | null;
  viewerCanUnresolve?: boolean | null;
  resolvedBy?: { login?: string | null } | null;
  comments?: {
    nodes?: Array<{
      id: string;
      databaseId?: number | null;
      body?: string | null;
      createdAt?: string | null;
      diffHunk?: string | null;
      path?: string | null;
      line?: number | null;
      originalLine?: number | null;
      url?: string | null;
      author?: { login?: string | null } | null;
    } | null> | null;
  } | null;
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

  return new GitHubRequestError(parts.join(' · '), {
    status: response.status,
    retryAfterMs: parseRetryAfterMs(response.headers),
  });
}

function parseRetryAfterMs(headers: Headers) {
  const value = headers.get('retry-after');
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

function isRetryableError(error: unknown) {
  if (error instanceof GitHubRequestError) {
    return error.status !== null && RETRYABLE_STATUS_CODES.has(error.status);
  }

  if (!(error instanceof Error)) return false;
  return /fetch failed|network|timed out|timeout/i.test(error.message);
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withGitHubRetry<T>(operation: () => Promise<T>) {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= DEFAULT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt >= DEFAULT_RETRY_DELAYS_MS.length) {
        throw error;
      }
      const retryDelayMs = error instanceof GitHubRequestError && error.retryAfterMs !== null
        ? error.retryAfterMs
        : DEFAULT_RETRY_DELAYS_MS[attempt];
      await wait(retryDelayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('GitHub request failed');
}

async function parseGitHubGraphQL<T>(
  repoFullName: string,
  query: string,
  variables: Record<string, unknown>,
) {
  const { response } = await githubInstallationFetch(repoFullName, '/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();

  if (!response.ok) {
    throw buildGitHubError(response, text);
  }

  const payload = JSON.parse(text) as GitHubGraphQLResponse<T>;
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const message = payload.errors
      .map((entry) => entry.message?.trim())
      .filter(Boolean)
      .join(' · ') || 'GitHub GraphQL request failed';
    throw new GitHubRequestError(message, {
      status: response.status,
      retryAfterMs: parseRetryAfterMs(response.headers),
    });
  }

  if (!payload.data) {
    throw new GitHubRequestError('GitHub GraphQL response did not include data.', {
      status: response.status,
      retryAfterMs: parseRetryAfterMs(response.headers),
    });
  }

  return payload.data;
}

function splitRepoFullName(repoFullName: string) {
  const [owner, name] = repoFullName.split('/');
  if (!owner || !name) {
    throw new Error('Invalid repo format');
  }
  return { owner, name };
}

function deriveThreadStatus(thread: { isResolved?: boolean | null; isOutdated?: boolean | null }): GitHubPullRequestReviewThreadStatus {
  if (thread.isResolved) return 'resolved';
  if (thread.isOutdated) return 'outdated';
  return 'active';
}

function normalizeReviewThread(node: PullRequestReviewThreadGraphQLNode): GitHubPullRequestReviewThread {
  const comments = (node.comments?.nodes ?? [])
    .filter((comment): comment is NonNullable<typeof comment> => Boolean(comment))
    .map((comment) => ({
      id: comment.id,
      databaseId: typeof comment.databaseId === 'number' ? comment.databaseId : null,
      author: comment.author?.login ?? 'unknown',
      body: comment.body ?? '',
      createdAt: comment.createdAt ?? '',
      diffHunk: comment.diffHunk ?? '',
      path: comment.path ?? node.path,
      line: typeof comment.line === 'number' ? comment.line : null,
      originalLine: typeof comment.originalLine === 'number' ? comment.originalLine : null,
      url: comment.url ?? '',
    }))
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());

  return {
    id: node.id,
    path: node.path,
    line: typeof node.line === 'number' ? node.line : null,
    originalLine: typeof node.originalLine === 'number' ? node.originalLine : null,
    startLine: typeof node.startLine === 'number' ? node.startLine : null,
    originalStartLine: typeof node.originalStartLine === 'number' ? node.originalStartLine : null,
    diffSide: node.diffSide ?? 'RIGHT',
    startDiffSide: node.startDiffSide ?? null,
    isResolved: Boolean(node.isResolved),
    isOutdated: Boolean(node.isOutdated),
    isCollapsed: Boolean(node.isCollapsed),
    status: deriveThreadStatus(node),
    subjectType: node.subjectType ?? 'LINE',
    viewerCanReply: Boolean(node.viewerCanReply),
    viewerCanResolve: Boolean(node.viewerCanResolve),
    viewerCanUnresolve: Boolean(node.viewerCanUnresolve),
    resolvedBy: node.resolvedBy?.login ?? null,
    latestCommentAt: comments[comments.length - 1]?.createdAt ?? '',
    comments,
  };
}

const REVIEW_THREAD_FIELDS = `
  id
  path
  line
  originalLine
  startLine
  originalStartLine
  diffSide
  startDiffSide
  isResolved
  isOutdated
  isCollapsed
  subjectType
  viewerCanReply
  viewerCanResolve
  viewerCanUnresolve
  resolvedBy {
    login
  }
  comments(first: 100) {
    nodes {
      id
      databaseId
      body
      createdAt
      diffHunk
      path
      line
      originalLine
      url
      author {
        login
      }
    }
  }
`;

export async function fetchGitHubPullRequestReviewThreads(repoFullName: string, prNumber: number) {
  const { owner, name } = splitRepoFullName(repoFullName);
  const data = await withGitHubRetry(() => parseGitHubGraphQL<{
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: Array<PullRequestReviewThreadGraphQLNode | null> | null;
        } | null;
      } | null;
    } | null;
  }>(
    repoFullName,
    `
      query PullRequestReviewThreads($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                ${REVIEW_THREAD_FIELDS}
              }
            }
          }
        }
      }
    `,
    { owner, name, number: prNumber },
  ));

  const nodes = data.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  return nodes
    .filter((node): node is PullRequestReviewThreadGraphQLNode => Boolean(node))
    .map(normalizeReviewThread)
    .sort((left, right) => new Date(right.latestCommentAt).getTime() - new Date(left.latestCommentAt).getTime());
}

export async function replyToGitHubPullRequestReviewThread(
  repoFullName: string,
  threadId: string,
  body: string,
) {
  await withGitHubRetry(() => parseGitHubGraphQL<{
    addPullRequestReviewThreadReply?: {
      comment?: { id?: string | null } | null;
    } | null;
  }>(
    repoFullName,
    `
      mutation AddPullRequestReviewThreadReply($threadId: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: {
          pullRequestReviewThreadId: $threadId
          body: $body
        }) {
          comment {
            id
          }
        }
      }
    `,
    { threadId, body },
  ));
}

export async function setGitHubPullRequestReviewThreadResolved(
  repoFullName: string,
  threadId: string,
  resolved: boolean,
) {
  await withGitHubRetry(() => parseGitHubGraphQL<{
    resolveReviewThread?: { thread?: { id?: string | null } | null } | null;
    unresolveReviewThread?: { thread?: { id?: string | null } | null } | null;
  }>(
    repoFullName,
    resolved
      ? `
        mutation ResolveReviewThread($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread {
              id
            }
          }
        }
      `
      : `
        mutation UnresolveReviewThread($threadId: ID!) {
          unresolveReviewThread(input: { threadId: $threadId }) {
            thread {
              id
            }
          }
        }
      `,
    { threadId },
  ));
}
