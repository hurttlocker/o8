import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-pr-reaper-data-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;
vi.resetModules();

vi.doMock('@/lib/github-broker/sync', () => ({
  ensureGitHubPullRequest: vi.fn(async (repoFullName: string, prNumber: number) => {
    const { getGitHubPullRequestByNumber } = await import('@/lib/github-broker/store');
    return {
      pr: getGitHubPullRequestByNumber(repoFullName, prNumber),
      error: null,
      stale: false,
    };
  }),
}));

const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { runWorktreeReaperTick } = await import('@/lib/lane/worktree-reaper');
const { upsertGitHubPullRequest } = await import('@/lib/github-broker/store');

const REPO_FULL_NAME = 'hurttlocker/o8-reaper-pr-test';

afterAll(() => {
  closeDb();
  vi.doUnmock('@/lib/github-broker/sync');
  vi.resetModules();
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'o8-pr-reaper-repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@o8.dev']);
  git(dir, ['config', 'user.name', 'o8 test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);
  git(dir, ['remote', 'add', 'origin', `https://github.com/${REPO_FULL_NAME}.git`]);
  return dir;
}

function markReviewing(laneId: string, prNumber: number | null): void {
  getSqlite().prepare(`
    UPDATE lanes
    SET status = 'reviewing', pr_number = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(prNumber, laneId);
}

function mirrorPullRequest(input: {
  number: number;
  headRefName: string;
  state: 'open' | 'closed';
  closedAt?: string | null;
  mergedAt?: string | null;
}) {
  upsertGitHubPullRequest({
    pullRequestId: 900_000 + input.number,
    repoFullName: REPO_FULL_NAME,
    number: input.number,
    title: `PR ${input.number}`,
    state: input.state,
    author: null,
    body: '',
    headRefName: input.headRefName,
    baseRefName: 'main',
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    reviewDecision: null,
    statusCheckRollup: [],
    url: `https://github.com/${REPO_FULL_NAME}/pull/${input.number}`,
    createdAt: '2026-07-03T12:00:00.000Z',
    updatedAt: '2026-07-03T12:05:00.000Z',
    closedAt: input.closedAt ?? null,
    mergedAt: input.mergedAt ?? null,
  });
}

describe('worktree reaper PR merge reconciliation', () => {
  it('archives a reviewing lane when its stamped PR mirror row is merged', async () => {
    const repoPath = makeRepo();
    const lane = createLane({
      repoPath,
      branch: 'inline/pr-merged',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-pr-merged',
    });
    markReviewing(lane.id, 301);
    mirrorPullRequest({
      number: 301,
      headRefName: lane.branch,
      state: 'closed',
      closedAt: '2026-07-03T12:10:00.000Z',
      mergedAt: '2026-07-03T12:10:00.000Z',
    });

    await runWorktreeReaperTick();

    expect(getLane(lane.id)?.status).toBe('archived');
    const event = getLaneEvents(lane.id).find((item) => item.verb === 'pr_merged_reconciled');
    expect(event?.payload.prNumber).toBe(301);
    expect(event?.payload.match).toBe('prNumber');
  });

  it('leaves a reviewing lane untouched when its stamped PR is closed but unmerged', async () => {
    const repoPath = makeRepo();
    const lane = createLane({
      repoPath,
      branch: 'inline/pr-closed-unmerged',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-pr-closed-unmerged',
    });
    markReviewing(lane.id, 302);
    mirrorPullRequest({
      number: 302,
      headRefName: lane.branch,
      state: 'closed',
      closedAt: '2026-07-03T12:15:00.000Z',
      mergedAt: null,
    });

    await runWorktreeReaperTick();

    expect(getLane(lane.id)?.status).toBe('reviewing');
    const event = getLaneEvents(lane.id).find((item) => item.verb === 'pr_merged_reconciled');
    expect(event).toBeUndefined();
  });

  it('archives legacy reviewing lanes by merged PR head branch when prNumber is missing', async () => {
    const repoPath = makeRepo();
    const lane = createLane({
      repoPath,
      branch: 'inline/legacy-pr-merged',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-legacy-pr-merged',
    });
    markReviewing(lane.id, null);
    mirrorPullRequest({
      number: 303,
      headRefName: lane.branch,
      state: 'closed',
      closedAt: '2026-07-03T12:20:00.000Z',
      mergedAt: '2026-07-03T12:20:00.000Z',
    });

    await runWorktreeReaperTick();

    expect(getLane(lane.id)?.status).toBe('archived');
    const event = getLaneEvents(lane.id).find((item) => item.verb === 'pr_merged_reconciled');
    expect(event?.payload.prNumber).toBe(303);
    expect(event?.payload.match).toBe('headRefName');
  });
});
