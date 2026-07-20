import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-heal-bot-review-release-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const { probeBranchMerged } = vi.hoisted(() => ({
  probeBranchMerged: vi.fn(async () => ({
    merged: true,
    mergeCommit: 'abc1234',
    ahead: 0,
  })),
}));

vi.mock('@/lib/orchestrator/branch-merge-probe', () => ({ probeBranchMerged }));

const { createLane, getLane, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { runAwaitingReviewAutoReleaseSweep } = await import('@/lib/supervisor/heal-bot');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('heal-bot durable-review release governance', () => {
  it('does not mark an externally merged unreviewed packet as plainly released', async () => {
    const packetId = `pkt-heal-unreviewed-${Date.now()}`;
    const lane = createLane({
      repoPath: '/tmp/o8-heal-bot-unreviewed',
      worktreePath: '/tmp/o8-heal-bot-unreviewed',
      branch: `inline/${packetId}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'ready_for_review');
    updateLane(lane.id, { lastEventAt: null, lastEventLabel: null });

    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: `mission-${packetId}`,
      repoPath: lane.repoPath,
      packets: [{
        id: packetId,
        referenceLabel: 'HEAL-1',
        title: 'Externally merged without review',
        summary: 'Exercise the heal-bot release path.',
        workspaceTargetPath: lane.repoPath,
        branchTarget: lane.branch,
        runtime: 'codex',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'held',
        releaseState: 'pending',
        status: 'awaiting_review',
        blockedReason: null,
        lastEventAt: null,
        lastEventLabel: null,
        archivedAt: null,
        review: null,
        lane: {
          tileId: lane.id,
          tabId: lane.id,
          repoPath: lane.repoPath,
          worktreePath: lane.worktreePath,
          runtime: 'codex',
          laneId: lane.id,
          sessionKey: null,
          lastEventAt: null,
          lastEventLabel: null,
        },
      }],
    });

    await runAwaitingReviewAutoReleaseSweep();

    const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId);
    expect(probeBranchMerged).toHaveBeenCalledWith({
      repoPath: lane.worktreePath,
      branch: 'HEAD',
      base: 'main',
    });
    expect(packet).toMatchObject({
      status: 'awaiting_review',
      releaseState: 'pending',
    });
    expect(getLane(lane.id)?.status).toBe('reviewing');
  });
});
