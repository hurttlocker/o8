import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const installationFetchMock = vi.hoisted(() => vi.fn());

vi.mock('./auth', () => ({
  githubInstallationFetch: installationFetchMock,
  hasGitHubBrokerAccess: () => true,
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-github-attention-sync-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { closeDb, getSqlite } = await import('@/lib/db');
const { ensureGitHubIssues } = await import('./sync');

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

beforeEach(() => {
  installationFetchMock.mockReset();
  const sqlite = getSqlite();
  sqlite.prepare('DELETE FROM github_issues').run();
  sqlite.prepare('DELETE FROM github_pull_requests').run();
  sqlite.prepare('DELETE FROM github_sync_state').run();
  sqlite.prepare('DELETE FROM github_installations').run();
});

afterEach(() => {
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
});
