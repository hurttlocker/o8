import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
const { sweepTerminalCortexWorktrees } = await import('@/lib/lane/terminal-worktree-sweep');
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

function makePacketWorktree(repoPath: string, branch: string, dirName: string): string {
  const worktreeRoot = join(repoPath, '.cortex-worktrees');
  const worktreePath = join(worktreeRoot, dirName);
  mkdirSync(worktreeRoot, { recursive: true });
  git(repoPath, ['branch', branch]);
  git(repoPath, ['worktree', 'add', '-q', worktreePath, branch]);
  return worktreePath;
}

async function waitForPathGone(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!existsSync(targetPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(existsSync(targetPath)).toBe(false);
}

function markReviewing(laneId: string, prNumber: number | null): void {
  getSqlite().prepare(`
    UPDATE lanes
    SET status = 'reviewing', pr_number = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(prNumber, laneId);
}

function markStatus(laneId: string, status: string): void {
  getSqlite().prepare(`
    UPDATE lanes
    SET status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, laneId);
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
    const worktreePath = makePacketWorktree(repoPath, 'inline/pr-merged', 'packet-pkt-pr-merged');
    const lane = createLane({
      repoPath,
      branch: 'inline/pr-merged',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-pr-merged',
      worktreePath,
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
    await waitForPathGone(worktreePath);
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

  it('startup sweep removes terminal and unknown clone dirs while keeping active and context dirs', async () => {
    const repoPath = makeRepo();
    const worktreeRoot = join(repoPath, '.cortex-worktrees');
    const activePath = join(worktreeRoot, 'packet-pkt-active-sweep');
    const terminalPath = join(worktreeRoot, 'packet-pkt-terminal-sweep');
    const unknownPath = join(worktreeRoot, 'packet-pkt-unknown-sweep');
    const contextPath = join(worktreeRoot, 'context');
    const scratchPath = join(worktreeRoot, 'scratch-sweep');
    mkdirSync(activePath, { recursive: true });
    mkdirSync(terminalPath, { recursive: true });
    mkdirSync(unknownPath, { recursive: true });
    mkdirSync(contextPath, { recursive: true });
    mkdirSync(scratchPath, { recursive: true });

    createLane({
      repoPath,
      branch: 'inline/active-sweep',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-active-sweep',
      worktreePath: activePath,
    });
    const terminalLane = createLane({
      repoPath,
      branch: 'inline/terminal-sweep',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-terminal-sweep',
      worktreePath: terminalPath,
    });
    markStatus(terminalLane.id, 'archived');

    const result = await sweepTerminalCortexWorktrees(repoPath);

    expect(result.removed).toBe(2);
    expect(existsSync(activePath)).toBe(true);
    expect(existsSync(terminalPath)).toBe(false);
    expect(existsSync(unknownPath)).toBe(false);
    expect(existsSync(contextPath)).toBe(true);
    expect(existsSync(scratchPath)).toBe(true);
  });
});
