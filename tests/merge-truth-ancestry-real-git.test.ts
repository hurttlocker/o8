import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const { appendEvent, createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { reconcileOrphanedWorktrees } = await import('@/lib/lane/reconcile');
const { listZombieLaneCandidates } = await import('@/lib/lane/reaper');
const { sweepPacketsMergedByAncestry } = await import('@/lib/orchestrator/merged-by-ancestry');
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
  it('does not complete a failed no-work lane when its worktree is missing', async () => {
    const repo = makeRepo('o8-no-work-missing-');
    git(repo, ['checkout', '-b', 'inline/no-work-failed']);
    const lane = createLane({
      repoPath: repo,
      worktreePath: missingWorktree(repo, 'missing-failed'),
      branch: 'inline/no-work-failed',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-no-work-failed-missing',
    });
    const exit = { exitCode: 1, classification: 'nonzero-exit', runtimeOutcome: 'failed', completedTurn: false };
    appendEvent(lane.id, 'runtime_process_exit', 'system', exit);
    setLaneStatus(lane.id, 'awaiting_input', 'system', 'agent_failed');

    await reconcileOrphanedWorktrees();
    expect(getLane(lane.id)?.status).not.toBe('completed');
    expect(getLane(lane.id)?.outcome).not.toBe('merged');
    expect(getLaneEvents(lane.id).find((event) => event.verb === 'runtime_process_exit')?.payload).toEqual(exit);
  });

  it('confirms a merged lane head with the lane head as ancestor and base as descendant', async () => {
    const repo = makeRepo('o8-merge-truth-merged-');
    git(repo, ['checkout', '-b', 'inline/merged']);
    const creationBase = git(repo, ['rev-parse', 'HEAD']);
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
      baseCommit: creationBase,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');

    expect(await reconcileOrphanedWorktrees()).toBeGreaterThanOrEqual(1);
    expect(getLane(lane.id)?.status).toBe('completed');
  });

  it('records launched work as merged when its branch later converges with the base', async () => {
    const repo = makeRepo('o8-merge-truth-converged-');
    git(repo, ['checkout', '-b', 'inline/converged']);
    const lane = createLane({
      repoPath: repo,
      worktreePath: missingWorktree(repo, 'missing-converged'),
      branch: 'inline/converged',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-converged',
    });
    writeFileSync(join(repo, 'feature.txt'), 'feature\n');
    commitAll(repo, 'feature');
    git(repo, ['checkout', 'main']);
    git(repo, ['merge', '--ff-only', 'inline/converged']);
    setLaneStatus(lane.id, 'reviewing', 'system', 'agent_completed');

    expect((await sweepPacketsMergedByAncestry()).merged).toBeGreaterThanOrEqual(1);
    expect(getLane(lane.id)).toMatchObject({ status: 'archived', outcome: 'merged' });
  });

  it('keeps a launched no-change branch truthful after the base advances', async () => {
    const repo = makeRepo('o8-merge-truth-no-change-');
    git(repo, ['checkout', '-b', 'inline/no-change']);
    const lane = createLane({
      repoPath: repo,
      worktreePath: missingWorktree(repo, 'missing-no-change'),
      branch: 'inline/no-change',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-no-change',
    });
    git(repo, ['checkout', 'main']);
    writeFileSync(join(repo, 'base.txt'), 'base\nadvanced\n');
    commitAll(repo, 'advance base');
    setLaneStatus(lane.id, 'reviewing', 'system', 'agent_completed');

    expect((await sweepPacketsMergedByAncestry()).merged).toBeGreaterThanOrEqual(1);
    expect(getLane(lane.id)).toMatchObject({ status: 'archived', outcome: 'no_changes' });
  });

  it('finishes a merging lane whose worktree metadata is already cleared when Git proves the merge landed', async () => {
    const repo = makeRepo('o8-merge-truth-cleared-path-');
    git(repo, ['checkout', '-b', 'inline/cleared-path']);
    writeFileSync(join(repo, 'feature.txt'), 'feature\n');
    const laneHead = commitAll(repo, 'feature');
    git(repo, ['checkout', 'main']);
    git(repo, ['merge', '--ff-only', 'inline/cleared-path']);
    git(repo, ['branch', '-D', 'inline/cleared-path']);
    const lane = createLane({
      repoPath: repo,
      branch: 'inline/cleared-path',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-cleared-path',
    });
    setLaneStatus(lane.id, 'merging', 'system', 'merging');
    appendEvent(lane.id, 'merge', 'system', { laneHeadSha: laneHead, baseBranch: 'main' });

    expect(await reconcileOrphanedWorktrees()).toBeGreaterThanOrEqual(1);
    expect(getLane(lane.id)?.status).toBe('completed');
  });

  it('surfaces a fresh merging wedge when its branch, repo lease, and owner process are absent', async () => {
    const repo = makeRepo('o8-merge-truth-abandoned-');
    const lane = createLane({
      repoPath: repo,
      branch: 'inline/never-created',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-abandoned-merging',
    });
    setLaneStatus(lane.id, 'merging', 'system', 'merging');

    const candidates = await listZombieLaneCandidates();
    expect(candidates.find((candidate) => candidate.lane.id === lane.id)).toMatchObject({
      reason: 'abandoned_merging',
      probe: { alive: false, source: 'merging-abandoned' },
    });
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
