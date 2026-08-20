import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

const { createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { approveAndMergePacket, submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'o8-review-head-repo-'));
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'test@o8.dev']);
  git(repoPath, ['config', 'user.name', 'o8 test']);
  writeFileSync(join(repoPath, 'base.txt'), 'base\n');
  git(repoPath, ['add', 'base.txt']);
  git(repoPath, ['commit', '-q', '-m', 'base']);
  return repoPath;
}

function commitFile(cwd: string, body: string, message: string): string {
  writeFileSync(join(cwd, 'feature.txt'), body);
  git(cwd, ['add', 'feature.txt']);
  git(cwd, ['commit', '-q', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function packetFixture(packetId: string, repoPath: string): OrchestratorPacket {
  return {
    id: packetId,
    referenceLabel: 'PKT-PIN',
    title: 'review integrity pin',
    summary: 'Pin reviewed diff to the reviewed HEAD.',
    status: 'awaiting_review',
    queueState: 'held',
    releaseState: 'pending',
    workspaceTargetPath: repoPath,
    branchTarget: 'main',
    blockedReason: null,
    lane: null,
    review: null,
    runtime: 'codex',
    dependencyPacketIds: [],
    dependencyLabels: [],
    attemptCount: 0,
    lastEventAt: new Date().toISOString(),
    lastEventLabel: 'review_requested',
    recoveryCount: 0,
    typecheckAutoRetries: 0,
    orchestratorThreadId: null,
  } as OrchestratorPacket;
}

async function withPrelaunchTypecheckSkipped<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
    } else {
      process.env.O8_SKIP_PRELAUNCH_TYPECHECK = previous;
    }
  }
}

describe('reviewed HEAD merge integrity', () => {
  it('warns when submit_review omits reviewedHeadSha', async () => {
    const repoPath = initRepo();
    const packetId = `pkt-review-unpinned-${Date.now()}`;
    const lane = createLane({
      repoPath,
      branch: 'inline/review-unpinned',
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      worktreePath: repoPath,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      repoPath,
      packets: [packetFixture(packetId, repoPath)],
    });

    const result = await submitPacketReview({ packetId, approved: true, findings: [] });
    // Omitted sha auto-captures the worktree HEAD at review time (keeps the
    // durable-review merge authorization working) with an advisory warning to
    // pass the packet-diff headSha for the exact-content pin.
    expect(result.reviewedHeadSha).toBe(git(repoPath, ['rev-parse', 'HEAD']));
    expect(result.warning).toContain('packet-diff headSha');
  });

  it('refuses when HEAD moves after review, then merges after re-review at the new HEAD', async () => {
    const repoPath = initRepo();
    const packetId = `pkt-review-head-${Date.now()}`;
    const branch = `inline/review-head-${Date.now()}`;
    const launch = await withPrelaunchTypecheckSkipped(() => prepareLaunchWorktree({
      repoRoot: repoPath,
      agentType: 'codex',
      taskName: 'review head integrity',
      branchName: branch,
      baseBranch: 'main',
      isolate: true,
      skipSetup: true,
      packetId,
    }));
    expect(launch).toBeTruthy();
    const worktreePath = launch!.cwd;
    const lane = createLane({
      repoPath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      worktreePath,
      sessionKey: `codex:${packetId}`,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      repoPath,
      packets: [packetFixture(packetId, repoPath)],
    });

    const shaA = commitFile(worktreePath, 'reviewed\n', 'feat: reviewed change [via-o8]');
    await submitPacketReview({ packetId, approved: true, findings: [], reviewedHeadSha: shaA });

    const shaB = commitFile(worktreePath, 'reviewed\npost-review\n', 'feat: post review change [via-o8]');
    const refused = await approveAndMergePacket({ packetId });
    expect(refused).toMatchObject({
      merged: false,
      reason: 'head_moved_since_review',
      reviewedHeadSha: shaA,
      currentHeadSha: shaB,
    });
    expect(getLaneEvents(lane.id).some((event) => (
      event.verb === 'review_invalidated'
      && event.payload.reviewedHeadSha === shaA
      && event.payload.currentHeadSha === shaB
    ))).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await submitPacketReview({ packetId, approved: true, findings: [], reviewedHeadSha: shaB });
    const merged = await approveAndMergePacket({ packetId });
    expect(merged.merged).toBe(true);
    expect(git(repoPath, ['rev-parse', 'HEAD'])).toBe(shaB);
    expect(getLane(lane.id)?.status).toBe('completed');
  }, 20_000);
});
