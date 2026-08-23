import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// The SQLite store resolves its data dir at module load. Force a temp o8 data
// dir before importing reset/registry so this real-path test never touches the
// operator's live control plane.
const dataDir = mkdtempSync(join(tmpdir(), 'o8-reset-cleanup-data-'));
delete process.env.O8_DATA_DIR;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DB_PATH = join(dataDir, 'cortex-ide.db');

const { getSqlite } = await import('@/lib/db');
const { appendEvent, createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { cleanupIssueBranch } = await import('@/lib/orchestrator/operator-mission-service/branch-cleanup');
const { resetPacket } = await import('@/lib/orchestrator/operator-mission-service/reset');
const { StorageAdmissionStore } = await import('@/lib/workspace/storage-admission');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(branch: string): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'o8-reset-cleanup-repo-'));
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'test@o8.dev']);
  git(repoPath, ['config', 'user.name', 'o8 test']);
  writeFileSync(join(repoPath, 'base.txt'), 'base\n');
  git(repoPath, ['add', 'base.txt']);
  git(repoPath, ['commit', '-q', '-m', 'base']);
  git(repoPath, ['branch', branch]);
  return repoPath;
}

function addPacketWorktree(repoPath: string, branch: string, packetId: string): string {
  const worktreePath = join(repoPath, '.cortex-worktrees', `packet-${packetId}`);
  git(repoPath, ['worktree', 'add', '-q', worktreePath, branch]);
  return worktreePath;
}

function branchExists(repoPath: string, branch: string): boolean {
  try {
    git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

describe('reset_packet clearWorktree branch cleanup', () => {
  it('releases a restored terminal lane reservation through cleanupIssueBranch', async () => {
    const branch = 'inline/restored-terminal-cleanup';
    const repoPath = initRepo(branch);
    const packetId = 'pkt-restored-terminal-cleanup';
    const worktreePath = join(repoPath, '.cortex-worktrees', `packet-${packetId}`);
    const lane = createLane({
      repoPath,
      branch,
      runtime: 'codex',
      packetId,
      worktreePath,
    });
    appendEvent(lane.id, 'update', 'orchestrator', {
      storageAdmissionOwnerGeneration: 1,
      storageAdmissionReservationId: 'packet-storage:restored-terminal-cleanup:1',
    });
    setLaneStatus(lane.id, 'completed', 'system', 'restored_terminal_lane');
    const now = Date.now();
    const store = new StorageAdmissionStore(getSqlite(), {
      now: () => now,
      observeVolume: async () => ({
        status: 'observed', targetPath: repoPath, probePath: repoPath,
        volumeId: 'device:restored-terminal-cleanup', availableBytes: 10_000,
        freeBytes: 10_000, totalBytes: 20_000, observedAt: now, error: null,
      }),
    });
    const reservationId = 'packet-storage:restored-terminal-cleanup:1';
    await store.reserve({
      mutationId: 'reserve-restored-terminal-cleanup', reservationId,
      targetPath: repoPath, exactBytes: 2_000, ownerId: packetId,
      ownerGeneration: 1, leaseExpiresAt: now + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
    });

    const result = await cleanupIssueBranch(repoPath, branch);

    expect(result).toMatchObject({ worktreePruned: true, branchDeleted: true });
    expect(existsSync(worktreePath)).toBe(false);
    expect(store.getReservation(reservationId)?.state).toBe('released');
  });

  it('archives only the reset packet lane and retains a branch owned by a live sibling lane', async () => {
    const branch = 'inline/reset-shared-branch';
    const repoPath = initRepo(branch);
    const packetA = 'pkt-reset-shared-a';
    const packetB = 'pkt-reset-shared-b';
    const worktreeA = addPacketWorktree(repoPath, branch, packetA);
    const laneA = createLane({
      repoPath,
      branch,
      runtime: 'codex',
      packetId: packetA,
      worktreePath: worktreeA,
    });
    setLaneStatus(laneA.id, 'running', 'system');
    const laneB = createLane({
      repoPath,
      branch,
      runtime: 'codex',
      packetId: packetB,
    });
    setLaneStatus(laneB.id, 'running', 'system');
    const siblingEventCount = getLaneEvents(laneB.id).length;

    const result = await resetPacket({ packetId: packetA, clearWorktree: true });

    expect(result.reset).toBe(true);
    expect(result.worktreePruned).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(existsSync(worktreeA)).toBe(false);
    expect(branchExists(repoPath, branch)).toBe(true);

    const resetLane = getLane(laneA.id);
    expect(resetLane?.status).toBe('archived');
    expect(resetLane?.packetId ?? '').toBe('');
    expect(resetLane?.worktreePath).toBeNull();

    const siblingLane = getLane(laneB.id);
    expect(siblingLane?.status).toBe('running');
    expect(siblingLane?.packetId).toBe(packetB);
    expect(getLaneEvents(laneB.id)).toHaveLength(siblingEventCount);

    const retainedEvent = getLaneEvents(laneA.id).find((event) => event.payload.branchRetained === true);
    expect(retainedEvent?.payload.reason).toBe('sibling_lane_active');
    expect(retainedEvent?.payload.siblingLaneIds).toEqual([laneB.id]);
  });

  it('fully prunes the worktree and branch for a single reset packet lane', async () => {
    const branch = 'inline/reset-single-branch';
    const repoPath = initRepo(branch);
    const packetId = 'pkt-reset-single';
    const worktreePath = addPacketWorktree(repoPath, branch, packetId);
    const lane = createLane({
      repoPath,
      branch,
      runtime: 'codex',
      packetId,
      worktreePath,
    });
    setLaneStatus(lane.id, 'running', 'system');

    const result = await resetPacket({ packetId, clearWorktree: true });

    expect(result.reset).toBe(true);
    expect(result.worktreePruned).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    expect(branchExists(repoPath, branch)).toBe(false);

    const resetLane = getLane(lane.id);
    expect(resetLane?.status).toBe('archived');
    expect(resetLane?.packetId ?? '').toBe('');
    expect(resetLane?.worktreePath).toBeNull();
  });
});
