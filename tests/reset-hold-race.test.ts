/**
 * #1527 — "held" that didn't hold, reproduced through the REAL reset path.
 *
 * resetPacket used to take a state snapshot at function entry, do seconds of
 * async cleanup (session interrupts, worktree prunes), then WHOLE-STATE-WRITE
 * the hold from that stale snapshot. A concurrent locked write in the window
 * was erased — and when TWO resets overlapped (the 2026-07-09 incident), the
 * second reset's stale snapshot still had the first packet as 'queued', so its
 * write reverted the first hold and the headless dispatch tick relaunched the
 * packet the operator had just archived.
 *
 * This test opens that exact window deterministically: the lane-session
 * interrupt is held on a deferred while a concurrent locked write lands a hold
 * on a SECOND packet (the same seam a parallel reset uses), then the first
 * reset completes. BOTH holds must survive.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-reset-hold-race-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

// Hold the reset's cleanup phase open so the test controls the race window.
let releaseCleanupGate: () => void = () => {};
const cleanupGate = new Promise<void>((resolve) => { releaseCleanupGate = resolve; });
vi.mock('@/lib/lane/reap-sessions', () => ({
  killLaneSessionsConfirmed: vi.fn(async () => {
    await cleanupGate;
    return [];
  }),
  archiveLaneSessions: vi.fn(async () => {}),
}));

const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const {
  readOrchestratorControlPlaneState,
  withLockedState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { resetPacket } = await import('@/lib/orchestrator/operator-mission-service/reset');
const { getDispatchBlocker } = await import('@/lib/orchestrator/scheduling');

function packetFixture(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-hold-race-a',
    referenceLabel: 'PKT-A',
    title: 'audit packet A',
    summary: 'analysis-only',
    workspaceTargetPath: null,
    branchTarget: 'issue/audit-a',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
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

describe('#1527 — reset hold cannot be reverted by writes racing the cleanup window', () => {
  it('a hold landed mid-cleanup survives the reset write, and the reset hold lands on fresh state', async () => {
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-hold-race',
      repoPath: join(dataDir, 'repo'),
      packets: [
        packetFixture(),
        packetFixture({ id: 'pkt-hold-race-b', referenceLabel: 'PKT-B', title: 'audit packet B', branchTarget: 'issue/audit-b' }),
      ],
    });

    // Start the reset — it takes its entry snapshot (both packets 'queued'),
    // then blocks inside the cleanup phase on the held session interrupt.
    const resetPromise = resetPacket({ packetId: 'pkt-hold-race-a', reason: 'archive analysis packet' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const duringCleanup = readOrchestratorControlPlaneState();
    const heldDuringCleanup = duringCleanup.packets.find((candidate) => candidate.id === 'pkt-hold-race-a');
    expect(heldDuringCleanup).toMatchObject({ queueState: 'held' });
    expect(getDispatchBlocker(heldDuringCleanup!, duringCleanup.packets)).toBe('Not queued');

    // The overlapping second reset: packet B's hold lands through the locked
    // seam while packet A's reset is still mid-cleanup.
    await withLockedState((state) => {
      const packetB = state.packets.find((candidate) => candidate.id === 'pkt-hold-race-b');
      if (!packetB) throw new Error('fixture packet B missing');
      packetB.status = 'draft';
      packetB.queueState = 'held';
      packetB.lane = null;
    });

    // Release the cleanup; the first reset completes and records its hold.
    releaseCleanupGate();
    const result = await resetPromise;
    expect(result.reset).toBe(true);

    const finalState = readOrchestratorControlPlaneState();
    const packetA = finalState.packets.find((packet) => packet.id === 'pkt-hold-race-a');
    const packetB = finalState.packets.find((packet) => packet.id === 'pkt-hold-race-b');

    // The reset's own hold landed…
    expect(packetA?.queueState).toBe('held');
    // …and the hold written during the race window was NOT reverted to
    // 'queued' — the exact revert that let the dispatch tick relaunch an
    // archived packet in the incident.
    expect(packetB?.queueState).toBe('held');
  });
});
