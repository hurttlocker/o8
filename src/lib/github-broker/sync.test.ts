import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GitHubIssueSnapshot,
  GitHubPullRequestSnapshot,
} from './store';

const installationFetchMock = vi.hoisted(() => vi.fn());

vi.mock('./auth', () => ({
  githubInstallationFetch: installationFetchMock,
  hasGitHubBrokerAccess: () => true,
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-github-attention-sync-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { closeDb, getSqlite } = await import('@/lib/db');
const {
  buildOutsideHumanWaitingInbox,
  enqueueInboxItem,
  resolveInboxItem,
} = await import('@/lib/supervisor/inbox');
const {
  invalidateGitHubSync,
  updateGitHubThreadAttention,
  upsertGitHubIssue,
  upsertGitHubPullRequest,
} = await import('./store');
const { ensureGitHubIssues, ensureGitHubPullRequests } = await import('./sync');

const NOW = new Date('2026-08-27T16:00:00.000Z');

const installation = {
  id: 1881,
  account: { login: 'example', type: 'Organization' },
  target_type: 'Organization',
  permissions: { issues: 'read' },
};

function fetched(body: unknown, status = 200) {
  return {
    response: Response.json(body, { status }),
    installation,
  };
}

function openIssue(number: number, comments: number) {
  return {
    id: 18_810 + number,
    number,
    title: 'Follow up on the extension contract',
    state: 'open',
    body: 'Initial thread body.',
    html_url: `https://github.com/example/widgets/issues/${number}`,
    created_at: '2026-08-24T10:00:00.000Z',
    updated_at: '2026-08-27T13:00:00.000Z',
    user: { login: 'thread-author', type: 'User' },
    author_association: 'CONTRIBUTOR',
    assignees: [],
    labels: [],
    comments,
  };
}

function issueSnapshot(
  number: number,
  state: 'open' | 'closed',
  closedAt: string | null,
  repoFullName = 'example/widgets',
): GitHubIssueSnapshot {
  return {
    issueId: 18_810 + number,
    repoFullName,
    number,
    title: `Issue ${number}`,
    state,
    author: { login: 'thread-author' },
    assignees: [],
    labels: [],
    comments: 0,
    body: 'Initial thread body.',
    url: `https://github.com/${repoFullName}/issues/${number}`,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: closedAt ?? '2026-08-27T13:00:00.000Z',
    closedAt,
  };
}

function pullRequestSnapshot(
  number: number,
  state: 'open' | 'closed',
  closedAt: string | null,
  repoFullName = 'example/widgets',
): GitHubPullRequestSnapshot {
  return {
    pullRequestId: 30_000 + number,
    repoFullName,
    number,
    title: `Pull request ${number}`,
    state,
    author: { login: 'thread-author' },
    body: 'Initial pull request body.',
    headRefName: `contributor/change-${number}`,
    baseRefName: 'main',
    additions: 4,
    deletions: 1,
    changedFiles: 1,
    reviewDecision: null,
    statusCheckRollup: [],
    url: `https://github.com/${repoFullName}/pull/${number}`,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: closedAt ?? '2026-08-27T13:00:00.000Z',
    closedAt,
    mergedAt: null,
  };
}

function pullRequestPayload(
  number: number,
  state: 'open' | 'closed' = 'open',
  closedAt: string | null = null,
) {
  const snapshot = pullRequestSnapshot(number, state, closedAt);
  return {
    id: snapshot.pullRequestId,
    number,
    title: snapshot.title,
    state: snapshot.state,
    body: snapshot.body,
    html_url: snapshot.url,
    created_at: snapshot.createdAt,
    updated_at: snapshot.updatedAt,
    closed_at: snapshot.closedAt,
    merged_at: snapshot.mergedAt,
    user: { login: snapshot.author!.login, type: 'User' },
    author_association: 'CONTRIBUTOR',
    head: { ref: snapshot.headRefName },
    base: { ref: snapshot.baseRefName },
    additions: snapshot.additions,
    deletions: snapshot.deletions,
    changed_files: snapshot.changedFiles,
    comments: 0,
  };
}

function enqueueWaitingCard(kind: 'issue' | 'pr', number: number) {
  return enqueueInboxItem({
    repoPath: dataDir,
    kind: 'outside_human_waiting',
    status: 'human_required',
    payload: {
      title: `Contributor waiting on example/widgets#${number}`,
      body: 'Waiting for a maintainer response.',
      url: `https://github.com/example/widgets/${kind === 'issue' ? 'issues' : 'pull'}/${number}`,
      threadRepo: 'example/widgets',
      threadKind: kind,
      threadNumber: number,
      threadTitle: `Thread ${number}`,
      waitingLogin: 'outside-contributor',
      waitingSince: '2026-08-18T16:00:00.000Z',
      hours: 216,
    },
  });
}

function mirrorNumbers(table: 'github_issues' | 'github_pull_requests', repoFullName: string): number[] {
  const rows = getSqlite().prepare(`
    SELECT number
    FROM ${table}
    WHERE repo_full_name = ?
    ORDER BY number
  `).all(repoFullName) as Array<{ number: number }>;
  return rows.map((row) => row.number);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  installationFetchMock.mockReset();
  buildOutsideHumanWaitingInbox(NOW, 24 * 60 * 60_000);
  const sqlite = getSqlite();
  sqlite.prepare("DELETE FROM supervisor_inbox WHERE kind = 'outside_human_waiting'").run();
  sqlite.prepare('DELETE FROM github_issues').run();
  sqlite.prepare('DELETE FROM github_pull_requests').run();
  sqlite.prepare('DELETE FROM github_sync_state').run();
  sqlite.prepare('DELETE FROM github_installations').run();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GitHub outsider attention sync', () => {
  it('keeps the latest human and insider comments across ascending comment pages', async () => {
    installationFetchMock.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes('/comments?') && path.endsWith('page=2')) {
        return fetched([{
          user: { login: 'outside-follow-up', type: 'User' },
          author_association: 'CONTRIBUTOR',
          created_at: '2026-08-27T13:00:00.000Z',
        }]);
      }
      if (path.includes('/comments?') && path.endsWith('page=1')) {
        return fetched([
          {
            user: { login: 'outside-first', type: 'User' },
            author_association: 'CONTRIBUTOR',
            created_at: '2026-08-25T10:00:00.000Z',
          },
          {
            user: { login: 'maintainer-reply', type: 'User' },
            author_association: 'MEMBER',
            created_at: '2026-08-26T10:00:00.000Z',
          },
        ]);
      }
      if (path.includes('/issues?state=open')) return fetched([openIssue(51, 101)]);
      if (path.includes('/issues?state=closed')) return fetched([]);
      throw new Error(`Unexpected GitHub path: ${path}`);
    });

    const result = await ensureGitHubIssues('example/widgets', { fresh: true });

    expect(result.error).toBeNull();
    expect(getSqlite().prepare(`
      SELECT last_human_comment_author_login as lastHumanLogin,
             last_human_comment_at as lastHumanAt,
             last_insider_comment_at as lastInsiderAt
      FROM github_issues
      WHERE repo_full_name = 'example/widgets' AND number = 51
    `).get()).toEqual({
      lastHumanLogin: 'outside-follow-up',
      lastHumanAt: '2026-08-27T13:00:00.000Z',
      lastInsiderAt: '2026-08-26T10:00:00.000Z',
    });
    expect(installationFetchMock.mock.calls
      .map((call) => String(call[1]))
      .filter((path) => path.includes('/comments?'))).toEqual([
      '/repos/example/widgets/issues/51/comments?per_page=100&page=2',
      '/repos/example/widgets/issues/51/comments?per_page=100&page=1',
    ]);
  });

  it('keeps the open issue mirror when attention fetching fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installationFetchMock.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes('/comments?')) throw new Error('attention request unavailable');
      if (path.includes('/issues?state=open')) return fetched([openIssue(52, 1)]);
      if (path.includes('/issues?state=closed')) return fetched([]);
      throw new Error(`Unexpected GitHub path: ${path}`);
    });

    await expect(ensureGitHubIssues('example/widgets', { fresh: true })).resolves.toMatchObject({
      error: null,
      issues: [expect.objectContaining({ number: 52 })],
      stale: false,
    });
    expect(getSqlite().prepare(`
      SELECT number, title
      FROM github_issues
      WHERE repo_full_name = 'example/widgets'
    `).all()).toEqual([{
      number: 52,
      title: 'Follow up on the extension contract',
    }]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(
      '[github-broker] Attention sync skipped for example/widgets#52: attention request unavailable',
    ));
  });

  it('backfills matching issues with null attention without refetching assessed rows', async () => {
    upsertGitHubIssue(issueSnapshot(61, 'open', null));
    upsertGitHubIssue(issueSnapshot(62, 'open', null));
    updateGitHubThreadAttention({
      repoFullName: 'example/widgets',
      kind: 'issue',
      number: 62,
      lastHumanCommentAuthorLogin: 'already-assessed',
      lastHumanCommentAuthorAssociation: 'CONTRIBUTOR',
      lastHumanCommentAt: '2026-08-26T11:00:00.000Z',
      lastInsiderCommentAt: null,
    });

    installationFetchMock.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes('/issues?state=open')) {
        return fetched([openIssue(61, 1), openIssue(62, 1)]);
      }
      if (path.includes('/issues?state=closed')) return fetched([]);
      if (path.includes('/issues/61/comments?')) {
        return fetched([{
          user: { login: 'backfilled-contributor', type: 'User' },
          author_association: 'CONTRIBUTOR',
          created_at: '2026-08-27T12:00:00.000Z',
        }]);
      }
      throw new Error(`Unexpected GitHub path: ${path}`);
    });

    await expect(ensureGitHubIssues('example/widgets', { fresh: true })).resolves.toMatchObject({
      error: null,
      stale: false,
    });

    expect(installationFetchMock.mock.calls
      .map((call) => String(call[1]))
      .filter((path) => path.includes('/comments?'))).toEqual([
      '/repos/example/widgets/issues/61/comments?per_page=100&page=1',
    ]);
    expect(getSqlite().prepare(`
      SELECT number, last_human_comment_author_login as login
      FROM github_issues
      WHERE repo_full_name = 'example/widgets' AND number IN (61, 62)
      ORDER BY number
    `).all()).toEqual([
      { number: 61, login: 'backfilled-contributor' },
      { number: 62, login: 'already-assessed' },
    ]);
  });

  it('backfills matching recently closed pull requests with null attention only', async () => {
    const closedAt = '2026-08-26T15:00:00.000Z';
    const unassessed = { ...pullRequestPayload(211, 'closed', closedAt), comments: 1 };
    const assessed = { ...pullRequestPayload(212, 'closed', closedAt), comments: 1 };
    upsertGitHubPullRequest(pullRequestSnapshot(211, 'closed', closedAt));
    upsertGitHubPullRequest(pullRequestSnapshot(212, 'closed', closedAt));
    updateGitHubThreadAttention({
      repoFullName: 'example/widgets',
      kind: 'pr',
      number: 212,
      lastHumanCommentAuthorLogin: 'already-assessed',
      lastHumanCommentAuthorAssociation: 'CONTRIBUTOR',
      lastHumanCommentAt: '2026-08-26T14:00:00.000Z',
      lastInsiderCommentAt: null,
    });

    installationFetchMock.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes('/pulls?state=open')) return fetched([]);
      if (path.includes('/pulls?state=closed')) return fetched([unassessed, assessed]);
      if (path.endsWith('/pulls/211')) return fetched(unassessed);
      if (path.includes('/issues/211/comments?')) {
        return fetched([{
          user: { login: 'backfilled-contributor', type: 'User' },
          author_association: 'CONTRIBUTOR',
          created_at: '2026-08-26T14:30:00.000Z',
        }]);
      }
      throw new Error(`Unexpected GitHub path: ${path}`);
    });

    await expect(ensureGitHubPullRequests('example/widgets')).resolves.toMatchObject({
      error: null,
      stale: false,
    });

    expect(installationFetchMock.mock.calls
      .map((call) => String(call[1]))
      .filter((path) => /\/pulls\/\d+$/.test(path))).toEqual([
      '/repos/example/widgets/pulls/211',
    ]);
    expect(installationFetchMock.mock.calls
      .map((call) => String(call[1]))
      .filter((path) => path.includes('/comments?'))).toEqual([
      '/repos/example/widgets/issues/211/comments?per_page=100&page=1',
    ]);
    expect(getSqlite().prepare(`
      SELECT number, last_human_comment_author_login as login
      FROM github_pull_requests
      WHERE repo_full_name = 'example/widgets' AND number IN (211, 212)
      ORDER BY number
    `).all()).toEqual([
      { number: 211, login: 'backfilled-contributor' },
      { number: 212, login: 'already-assessed' },
    ]);
  });

  it('prunes expired closed issues after their active waiting card resolves', async () => {
    upsertGitHubIssue(issueSnapshot(101, 'closed', '2026-08-19T15:59:59.000Z'));
    upsertGitHubIssue(issueSnapshot(102, 'closed', '2026-08-25T16:00:00.000Z'));
    upsertGitHubIssue(issueSnapshot(103, 'open', null));
    upsertGitHubIssue(issueSnapshot(104, 'closed', '2026-08-19T15:59:59.000Z'));
    upsertGitHubIssue(issueSnapshot(105, 'closed', '2026-08-19T15:59:59.000Z', 'other/widgets'));
    const card = enqueueWaitingCard('issue', 104);

    installationFetchMock.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes('/issues?state=open')) return fetched([openIssue(103, 0)]);
      if (path.includes('/issues?state=closed')) return fetched([]);
      throw new Error(`Unexpected GitHub path: ${path}`);
    });

    await expect(ensureGitHubIssues('example/widgets', { fresh: true })).resolves.toMatchObject({
      error: null,
      stale: false,
    });
    expect(mirrorNumbers('github_issues', 'example/widgets')).toEqual([102, 103, 104]);
    expect(mirrorNumbers('github_issues', 'other/widgets')).toEqual([105]);

    resolveInboxItem(card.id, null);
    await ensureGitHubIssues('example/widgets', { fresh: true });

    expect(mirrorNumbers('github_issues', 'example/widgets')).toEqual([102, 103]);
  });

  it('prunes expired closed pull requests after their active waiting card resolves', async () => {
    upsertGitHubPullRequest(pullRequestSnapshot(201, 'closed', '2026-08-19T15:59:59.000Z'));
    upsertGitHubPullRequest(pullRequestSnapshot(202, 'closed', '2026-08-25T16:00:00.000Z'));
    upsertGitHubPullRequest(pullRequestSnapshot(203, 'open', null));
    upsertGitHubPullRequest(pullRequestSnapshot(204, 'closed', '2026-08-19T15:59:59.000Z'));
    upsertGitHubPullRequest(pullRequestSnapshot(205, 'closed', '2026-08-19T15:59:59.000Z', 'other/widgets'));
    const card = enqueueWaitingCard('pr', 204);
    const openPull = pullRequestPayload(203);

    installationFetchMock.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes('/pulls?state=open')) return fetched([openPull]);
      if (path.includes('/pulls?state=closed')) return fetched([]);
      if (path.endsWith('/pulls/203')) return fetched(openPull);
      throw new Error(`Unexpected GitHub path: ${path}`);
    });

    await expect(ensureGitHubPullRequests('example/widgets')).resolves.toMatchObject({
      error: null,
      stale: false,
    });
    expect(mirrorNumbers('github_pull_requests', 'example/widgets')).toEqual([202, 203, 204]);
    expect(mirrorNumbers('github_pull_requests', 'other/widgets')).toEqual([205]);

    resolveInboxItem(card.id, null);
    invalidateGitHubSync('example/widgets', 'pull_requests');
    await ensureGitHubPullRequests('example/widgets');

    expect(mirrorNumbers('github_pull_requests', 'example/widgets')).toEqual([202, 203]);
  });
});
