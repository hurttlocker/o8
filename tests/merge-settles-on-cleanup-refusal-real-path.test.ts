/**
 * #2493 — a merge that succeeded settles with a recorded cleanup outcome when
 * the live-process guard cannot clear the worktree.
 *
 * Drives `approveAndMergePacket` (the MCP approve_and_merge entry) against a
 * real repo, a real managed worktree from `prepareLaunchWorktree`, and a
 * persisted lane, with the machine cwd snapshot forced into the state a
 * timed-out `lsof` produces. The guard must keep failing closed (worktree kept),
 * while the merge returns, the lane reaches its merged outcome, and a lane event
 * names the skipped cleanup and its reason.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const snapshotMock = vi.hoisted(() => ({ calls: 0 }));

vi.mock('@/lib/runtime/process-cwd-snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtime/process-cwd-snapshot')>();
  return {
    ...actual,
    // The shape readProcessCwdSnapshot returns when lsof hits its 3 s timeout.
    readProcessCwdSnapshot: vi.fn(async () => {
      snapshotMock.calls += 1;
      return {
        status: 'unavailable' as const,
        rows: [],
        capturedAt: Date.now(),
        reason: 'Command failed: lsof -nP -d cwd -F pcn (timed out)',
      };
    }),
  };
});

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  DispatchPreflightError: class extends Error {},
  assertRuntimeDispatchable: vi.fn(async () => {}),
  getRuntimeAuthSnapshot: vi.fn(async () => ({ statuses: {}, suggestedSubscriptionProfile: { profile: null, detail: null } })),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-merge-settles-'));
const tempDirs: string[] = [dataDir];
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { approveAndMergePacket, submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service');
const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeMergeRepo(): string {
  const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-2493-repo-'));
  const originPath = mkdtempSync(join(os.tmpdir(), 'o8-2493-origin-'));
  tempDirs.push(repoPath, originPath);
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'test@o8.dev']);
  git(repoPath, ['config', 'user.name', 'o8 test']);
  writeFileSync(join(repoPath, 'base.txt'), 'base\n');
  git(repoPath, ['add', 'base.txt']);
  git(repoPath, ['commit', '-q', '-m', 'base']);
  git(originPath, ['init', '-q', '--bare']);
  git(repoPath, ['remote', 'add', 'origin', originPath]);
  git(repoPath, ['push', '-q', '-u', 'origin', 'main']);
  return repoPath;
}

describe('#2493 — merge settles when the post-merge cleanup is refused', () => {
  it('inconclusive live-process probe: merge returns, lane is merged, worktree kept, skip recorded with reason', async () => {
    // Merge crosses the storage governor, which is not what this case proves.
    await updateOperatorDefaults({ storageReserveRatio: 0.0001, storageReserveFloorGb: 0.001 });
    const repoPath = makeMergeRepo();
    const packetId = 'pkt-2493-cleanup-refused';
    const branch = 'inline/2493-cleanup-refused';

    const previous = process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
    const launch = await prepareLaunchWorktree({
      repoRoot: repoPath,
      agentType: 'codex',
      taskName: `merge settles ${packetId}`,
      branchName: branch,
      baseBranch: 'main',
      isolate: true,
      skipSetup: true,
      packetId,
    }).finally(() => {
      if (previous === undefined) delete process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
      else process.env.O8_SKIP_PRELAUNCH_TYPECHECK = previous;
    });
    expect(launch).toBeTruthy();
    const worktreePath = launch!.cwd;
    tempDirs.push(worktreePath);

    const lane = createLane({ repoPath, worktreePath, branch, baseBranch: 'main', runtime: 'codex', packetId });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature\n');
    git(worktreePath, ['add', 'feature.txt']);
    git(worktreePath, ['commit', '-q', '-m', 'feat: cleanup refusal seam [via-o8]']);
    const reviewedHead = gitOut(worktreePath, ['rev-parse', 'HEAD']);
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      repoPath,
      packets: [{
        id: packetId,
        referenceLabel: 'PKT-2493',
        title: 'merge settles on cleanup refusal',
        summary: 'Exercise the post-merge cleanup refusal through the real service.',
        status: 'awaiting_review',
        queueState: 'held',
        releaseState: 'pending',
        blockedReason: null,
        lane: null,
        review: null,
        runtime: 'codex',
        dependencyPacketIds: [],
        dependencyLabels: [],
        attemptCount: 0,
        lastEventAt: '2026-09-18T00:00:00.000Z',
        lastEventLabel: 'created',
        recoveryCount: 0,
        typecheckAutoRetries: 0,
        orchestratorThreadId: null,
        workspaceTargetPath: repoPath,
        branchTarget: 'main',
      } as OrchestratorPacket],
    });
    await submitPacketReview({ packetId, approved: true, findings: [], reviewedHeadSha: reviewedHead });

    const snapshotCallsBefore = snapshotMock.calls;
    const startedAt = Date.now();
    const result = await approveAndMergePacket({ packetId });
    const mergeMs = Date.now() - startedAt;

    expect(result.merged).toBe(true);
    expect(result.mergeSha).toBe(gitOut(repoPath, ['rev-parse', 'HEAD']));
    expect(mergeMs).toBeLessThan(15_000);
    // The guard ran against the timed-out snapshot and kept the worktree.
    expect(snapshotMock.calls).toBeGreaterThan(snapshotCallsBefore);
    expect(existsSync(worktreePath)).toBe(true);
    expect(getLane(lane.id)?.outcome).toBe('merged');
    const skipped = getLaneEvents(lane.id).find((event) =>
      event.verb === 'update' && event.payload.phase === 'merge_cleanup_skipped');
    expect(skipped?.payload).toMatchObject({ reason: 'inconclusive', worktreePath });
  }, 90_000);
});
