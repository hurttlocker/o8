/**
 * #1488 — the task-evaporation race, reproduced through the REAL paths.
 *
 * submitPacketReview used to take a state snapshot at function entry, do
 * async git work (reviewed-HEAD capture), then WHOLE-STATE-WRITE from that
 * stale snapshot. A queued packet created in the window (o8_task_create —
 * which has no lane for the reconciler to resurrect it from) was silently
 * erased: create returned ok, dispatch seconds later said "Task not found".
 *
 * This test opens that exact window deterministically: the reviewed-HEAD
 * capture is held on a deferred while a queued packet lands via
 * withLockedState (the same seam o8_task_create uses), then the review
 * completes. Both the review AND the mid-flight packet must survive.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-review-race-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

// Hold the reviewed-HEAD capture open so the test controls the race window.
let releaseHeadCapture: (sha: string) => void = () => {};
const headCaptureGate = new Promise<string>((resolve) => { releaseHeadCapture = resolve; });
vi.mock('@/lib/lane/head-sha-lock', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/lane/head-sha-lock')>();
  return {
    ...original,
    readHeadSha: vi.fn(() => headCaptureGate),
  };
});

const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const {
  readOrchestratorControlPlaneState,
  withLockedState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createLane } = await import('@/lib/lane/registry');
const { submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service/review');

function packetFixture(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-race-under-review',
    referenceLabel: 'PKT-RACE',
    title: 'packet under review',
    summary: 'review target',
    workspaceTargetPath: null,
    branchTarget: 'issue/race',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'running',
    blockedReason: null,
    lastEventAt: null,
    lastEventLabel: null,
    archivedAt: null,
    review: null,
    lane: null,
    orchestratorThreadId: null,
    ...overrides,
  };
}

describe('#1488 — review write cannot erase packets created mid-review', () => {
  it('a queued task created during the reviewed-HEAD capture survives the review write', async () => {
    // A lane bound to the packet gives the HEAD capture a worktree to probe
    // (the mocked readHeadSha holds the gate open regardless).
    const lane = createLane({
      label: 'race lane',
      repoPath: join(dataDir, 'repo'),
      branch: 'issue/race',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-race-under-review',
    });
    const { updateLane } = await import('@/lib/lane/registry');
    updateLane(lane.id, { worktreePath: join(dataDir, 'repo-worktree') });

    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-race',
      packets: [packetFixture()],
    });

    // Start the review — it takes its entry snapshot, then blocks on the
    // held HEAD capture.
    const reviewPromise = submitPacketReview({
      packetId: 'pkt-race-under-review',
      approved: true,
      findings: [],
    });
    // Let the review reach the gate.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The mid-flight task_create: a queued packet lands through the same
    // locked seam the task pool uses.
    await withLockedState((state) => {
      state.packets.push(packetFixture({
        id: 'pkt-race-created-mid-review',
        referenceLabel: 'PKT-MID',
        title: 'created while review was in flight',
        status: 'queued',
      }));
    });

    // Release the capture; the review completes and writes.
    releaseHeadCapture('a'.repeat(40));
    const result = await reviewPromise;
    expect(result.recorded).toBe(true);

    const finalState = readOrchestratorControlPlaneState();
    const reviewed = finalState.packets.find((packet) => packet.id === 'pkt-race-under-review');
    const midFlight = finalState.packets.find((packet) => packet.id === 'pkt-race-created-mid-review');

    // The review landed…
    expect(reviewed?.review?.approved).toBe(true);
    // …and the packet created during the race window was NOT erased.
    expect(midFlight).toBeTruthy();
    expect(midFlight?.title).toBe('created while review was in flight');
  });
});
