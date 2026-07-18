/**
 * Adversarial-review blockers F1/F2 on the #1528 stop backgrounding: a stop's
 * backgrounded cleanup must never touch a LEGITIMATE re-dispatch of the same
 * packet that happened during the cleanup window.
 *
 * F1: the cleanup's final hold used to stomp whatever packet state sat at the
 * id — reverting a live re-dispatch to draft/held with lane=null.
 * F2: the orphan-worktree prefix glob (`packet-<id>*`) used to rm -rf the
 * re-dispatched worker's LIVE worktree (deterministic naming — same prefix).
 *
 * These drive the REAL resetPacket with the generation scope the stop path
 * now passes, against the re-dispatched state, and assert the new lane, the
 * new worktree dir, and the packet's live state all survive.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-stop-generation-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

vi.mock('@/lib/lane/reap-sessions', () => ({
  interruptLaneSessions: vi.fn(async () => 0),
  archiveLaneSessions: vi.fn(async () => 0),
}));

const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createLane, getLane } = await import('@/lib/lane/registry');
const { resetPacket } = await import('@/lib/orchestrator/operator-mission-service/reset');

function packetFixture(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-generation',
    referenceLabel: 'PKT-GEN',
    title: 'stopped then re-dispatched',
    summary: 'generation guard target',
    workspaceTargetPath: null,
    branchTarget: 'issue/generation',
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
    operatorStopped: false,
    ...overrides,
  };
}

describe('stop background cleanup generation guard (F1/F2)', () => {
  it('a re-dispatch during the cleanup window survives the scoped reset untouched', async () => {
    const repoPath = join(dataDir, 'repo');
    mkdirSync(repoPath, { recursive: true });

    // The lane the STOP captured (old generation)…
    const oldLane = createLane({
      label: 'old generation lane',
      repoPath,
      branch: 'issue/generation',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-generation',
    });
    // …and the lane a legitimate re-dispatch bound DURING the cleanup window.
    const newLane = createLane({
      label: 'live re-dispatch lane',
      repoPath,
      branch: 'issue/generation-2',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-generation',
    });

    // The re-dispatched worker's live worktree — matches the packet prefix
    // the old glob sweep destroyed.
    const liveWorktree = join(repoPath, '.cortex-worktrees', 'packet-pkt-generation-live');
    mkdirSync(liveWorktree, { recursive: true });
    writeFileSync(join(liveWorktree, 'in-progress.ts'), 'export const work = true;\n');

    // Mission state as the re-dispatch left it: running, NOT operator-stopped.
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-generation',
      repoPath,
      packets: [packetFixture()],
    });

    // The backgrounded cleanup finally runs, scoped to the stop-time capture.
    const result = await resetPacket({
      packetId: 'pkt-generation',
      clearWorktree: true,
      reason: 'stopped by operator (#1286)',
      scope: { laneIds: [oldLane.id], skipHoldIfStateMoved: true },
    });
    expect(result.reset).toBe(true);

    // F2 — the live re-dispatch worktree survives.
    expect(existsSync(join(liveWorktree, 'in-progress.ts'))).toBe(true);

    // F1 — the packet's live state was NOT stomped back to draft/held.
    const state = readOrchestratorControlPlaneState();
    const packet = state.packets.find((candidate) => candidate.id === 'pkt-generation');
    expect(packet?.queueState).not.toBe('held');
    expect(packet?.status).not.toBe('draft');

    // Scope — the old-generation lane was cleaned, the new lane untouched.
    const oldAfter = getLane(oldLane.id);
    const newAfter = getLane(newLane.id);
    expect(oldAfter?.packetId ?? '').toBe('');
    expect(newAfter?.packetId).toBe('pkt-generation');
    expect(newAfter?.status).not.toBe('archived');
  });
});
