/**
 * #1528 — stop must answer at kill-confirm, never wait out the cleanup.
 *
 * stopPacket used to hold its response through resetPacket's full cleanup —
 * archiving lanes plus rm -rf of a node_modules-cloned worktree, minutes of
 * I/O — until the CLI's HTTP client timed out and misreported
 * connection_refused while the server was listening. The operator could not
 * halt a running mission with the one verb that must be fast.
 *
 * These tests gate the cleanup on a deferred (standing in for the minutes of
 * prune I/O) and assert the REAL stopPacket path: (1) the response returns
 * while cleanup is still running, with the packet already held against
 * relaunch under the control-plane lock; (2) stopping something that does not
 * exist anywhere is an immediate success, not a hang or a throw.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-stop-fast-ack-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

// Stand-in for the minutes-long archive + worktree prune.
let releaseCleanup: () => void = () => {};
const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
const resetPacketMock = vi.fn(async () => {
  await cleanupGate;
  return { reset: true, worktreePruned: true };
});
vi.mock('@/lib/orchestrator/operator-mission-service', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/orchestrator/operator-mission-service')>();
  return { ...original, resetPacket: resetPacketMock };
});

const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createLane } = await import('@/lib/lane/registry');
const { stopPacket } = await import('@/lib/orchestrator/stop-packet');

function packetFixture(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-stop-fast',
    referenceLabel: 'PKT-STOP',
    title: 'runaway packet',
    summary: 'live worker to halt',
    workspaceTargetPath: null,
    branchTarget: 'issue/runaway',
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

describe('#1528 — stop answers at kill-confirm, cleanup runs in the background', () => {
  it('returns while cleanup is still gated, with the packet already held against relaunch', async () => {
    createLane({
      label: 'runaway lane',
      repoPath: join(dataDir, 'repo'),
      branch: 'issue/runaway',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-stop-fast',
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-stop-fast',
      repoPath: join(dataDir, 'repo'),
      packets: [packetFixture()],
    });

    // The old code awaited the cleanup — with the gate closed it would hang
    // here forever (the incident's minutes-long stall). 5s is generous slack
    // for the locked hold write; the contract is "seconds, not minutes".
    const result = await Promise.race([
      stopPacket('pkt-stop-fast'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stopPacket did not ack before cleanup finished')), 5_000)),
    ]);

    expect(result.ok).toBe(true);
    expect(result.killConfirmed).toBe(true);
    expect(resetPacketMock).toHaveBeenCalledOnce();

    // The anti-relaunch guard is durable BEFORE the response: held +
    // operator-stopped in persisted state while cleanup is still running.
    const state = readOrchestratorControlPlaneState();
    const packet = state.packets.find((candidate) => candidate.id === 'pkt-stop-fast');
    expect(packet?.queueState).toBe('held');
    expect(packet?.operatorStopped).toBe(true);

    releaseCleanup();
  });

  it('stopping a packet that exists nowhere is an immediate success, not a throw', async () => {
    const before = resetPacketMock.mock.calls.length;
    const result = await stopPacket('pkt-never-existed');
    expect(result.ok).toBe(true);
    expect(result.note).toContain('Nothing to stop');
    expect(resetPacketMock.mock.calls.length).toBe(before);
  });
});
