import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { reconcileOrphanedWorktrees } = await import('@/lib/lane/reconcile');
const { isAncestorCommit } = await import('@/lib/orchestrator/operator-mission-service/merge-truth');
const { createWorkspaceSnapshot, transitionWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function makeRepo(name: string) {
  const repo = mkdtempSync(join(os.tmpdir(), name));
  roots.push(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  commitAll(repo, 'base');
  return repo;
}

function missingWorktree(repo: string, name: string) {
  const path = join(repo, name);
  expect(existsSync(path)).toBe(false);
  return path;
}

function persistWorkspaceState(
  lane: ReturnType<typeof createLane>,
  state: 'parked' | 'hibernating' | 'restoring',
  head: string,
) {
  const packetId = lane.packetId!;
  const repositoryUuid = `repo-${packetId}`;
  let record = createWorkspaceSnapshot({
    repositoryUuid,
    packetId,
    laneId: lane.id,
    originalPath: lane.worktreePath!,
    branch: lane.branch,
    baseCommit: head,
    headCommit: head,
    treeSha: head,
    recoveryRef: `refs/o8/recovery/${packetId}`,
    diffFingerprint: `diff-${packetId}`,
    sessionIdentities: [],
    creationId: `create-${packetId}`,
  }).record;
  const transitions = state === 'hibernating'
    ? ['parkable', 'hibernating'] as const
    : state === 'parked'
      ? ['parkable', 'hibernating', 'parked'] as const
      : ['parkable', 'hibernating', 'parked', 'restoring'] as const;
  for (const toState of transitions) {
    const result = transitionWorkspaceSnapshot({
      repositoryUuid,
      packetId,
      transitionId: `${packetId}-${toState}`,
      expectedState: record.state,
      expectedVersion: record.version,
      toState,
    });
    if (!result.record) throw new Error('Workspace snapshot transition unexpectedly disappeared.');
    record = result.record;
  }
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('merge truth by git ancestry', () => {
  it('confirms a merged lane head with the lane head as ancestor and base as descendant', async () => {
    const repo = makeRepo('o8-merge-truth-merged-');
    git(repo, ['checkout', '-b', 'inline/merged']);
    writeFileSync(join(repo, 'feature.txt'), 'feature\n');
    const laneHead = commitAll(repo, 'feature');
    git(repo, ['checkout', 'main']);
    git(repo, ['merge', '--ff-only', 'inline/merged']);

    expect(await isAncestorCommit(repo, laneHead, 'main')).toBe(true);

    const lane = createLane({
      repoPath: repo,
      worktreePath: missingWorktree(repo, 'missing-merged'),
      branch: 'inline/merged',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-merged',
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');

    expect(await reconcileOrphanedWorktrees()).toBeGreaterThanOrEqual(1);
    expect(getLane(lane.id)?.status).toBe('completed');
  });

  it('reports not merged when the branch contains the advanced base but base lacks the lane head', async () => {
    const repo = makeRepo('o8-merge-truth-swapped-');
    git(repo, ['checkout', '-b', 'inline/swapped']);
    writeFileSync(join(repo, 'feature.txt'), 'feature\n');
    const laneHead = commitAll(repo, 'feature');
    git(repo, ['checkout', 'main']);
    writeFileSync(join(repo, 'base.txt'), 'base\nadvanced\n');
    commitAll(repo, 'advance base');
    git(repo, ['checkout', 'inline/swapped']);
    git(repo, ['merge', '--no-edit', 'main']);
    git(repo, ['checkout', 'main']);

    expect(await isAncestorCommit(repo, laneHead, 'main')).toBe(false);
    expect(await isAncestorCommit(repo, 'main', 'inline/swapped')).toBe(true);

    const lane = createLane({
      repoPath: repo,
      worktreePath: missingWorktree(repo, 'missing-swapped'),
      branch: 'inline/swapped',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-swapped',
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');

    expect(await reconcileOrphanedWorktrees()).toBe(0);
    expect(getLane(lane.id)?.status).toBe('awaiting_orchestrator');
  });

  it('treats squash-merged content as unconfirmed because the lane head is not in ancestry', async () => {
    const repo = makeRepo('o8-merge-truth-squash-');
    git(repo, ['checkout', '-b', 'inline/squash']);
    writeFileSync(join(repo, 'squash.txt'), 'squash\n');
    commitAll(repo, 'squash feature');
    git(repo, ['checkout', 'main']);
    git(repo, ['merge', '--squash', 'inline/squash']);
    commitAll(repo, 'squash merge feature');

    const lane = createLane({
      repoPath: repo,
      worktreePath: missingWorktree(repo, 'missing-squash'),
      branch: 'inline/squash',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-squash',
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');

    // Squash merge lands equivalent content in a new commit, so SHA ancestry
    // cannot prove the reviewed lane head landed. Keep it review-visible.
    expect(await reconcileOrphanedWorktrees()).toBe(0);
    expect(getLane(lane.id)?.status).toBe('awaiting_orchestrator');
  });

  it('keeps a missing-worktree lane review-visible when no lane-head evidence exists', async () => {
    const repo = makeRepo('o8-merge-truth-no-sha-');
    git(repo, ['checkout', '-b', 'inline/no-sha']);
    writeFileSync(join(repo, 'lost.txt'), 'lost\n');
    commitAll(repo, 'lost feature');
    git(repo, ['checkout', 'main']);
    git(repo, ['branch', '-D', 'inline/no-sha']);

    const lane = createLane({
      repoPath: repo,
      worktreePath: missingWorktree(repo, 'missing-no-sha'),
      branch: 'inline/no-sha',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-no-sha',
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');

    expect(await reconcileOrphanedWorktrees()).toBe(0);
    expect(getLane(lane.id)?.status).toBe('awaiting_orchestrator');
  });

  it.each(['parked', 'hibernating', 'restoring'] as const)(
    'does not reinterpret an intentionally %s workspace as an orphaned lane',
    async (state) => {
      const repo = makeRepo(`o8-merge-truth-${state}-`);
      const head = git(repo, ['rev-parse', 'HEAD']);
      const packetId = `pkt-${state}-${Date.now()}`;
      const lane = createLane({
        repoPath: repo,
        worktreePath: missingWorktree(repo, `missing-${state}`),
        branch: `inline/${state}`,
        baseBranch: 'main',
        runtime: 'codex',
        packetId,
      });
      setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');
      persistWorkspaceState(lane, state, head);

      expect(await reconcileOrphanedWorktrees()).toBe(0);
      expect(getLane(lane.id)?.status).toBe('reviewing');
    },
  );
});
