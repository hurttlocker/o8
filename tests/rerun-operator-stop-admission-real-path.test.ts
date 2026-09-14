import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const h = vi.hoisted(() => ({
  kill: vi.fn(),
  archive: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock('@/lib/lane/reap-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/reap-sessions')>();
  return { ...actual, killLaneSessionsConfirmed: h.kill, archiveLaneSessionsConfirmed: h.archive };
});
vi.mock('@/lib/orchestrator/dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/dispatch')>();
  return { ...actual, runDispatchTick: h.dispatch };
});

const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
};

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-rerun-stop-admission-data-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { writeOrchestratorControlPlaneState, readOrchestratorControlPlaneState } =
  await import('@/lib/orchestrator/control-plane');
const { rerunWithFeedback } = await import('@/lib/orchestrator/operator-mission-service');
const { PacketOperatorStopPreservedError } = await import('@/lib/orchestrator/packet-lifecycle-guard');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const { getSqlite } = await import('@/lib/db');
const { createLane, listLanes } = await import('@/lib/lane/registry');

function stoppedPacket(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-rerun-stop',
    referenceLabel: 'P1',
    title: 'stopped packet',
    summary: 'A stopped packet.',
    status: 'blocked',
    queueState: 'held',
    releaseState: 'pending',
    blockedReason: 'operator_stopped',
    operatorStopped: true,
    lane: null,
    review: null,
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    attemptCount: 0,
    lastEventAt: null,
    lastEventLabel: 'operator_stopped',
    archivedAt: null,
    workspaceTargetPath: null,
    branchTarget: 'inline/rerun-stop',
    ...overrides,
  } as OrchestratorPacket;
}

/** Insert a mission-registry-only packet copy (no active control-plane state). */
function insertRegistryMission(missionId: string, repoPath: string, packets: OrchestratorPacket[]) {
  const state = { ...createEmptyOrchestratorMissionState(), missionId, repoPath, packets };
  const now = Date.now();
  getSqlite().prepare(
    `INSERT INTO missions (
       id, repo_path, runtime, prompt, summary, constraints, packet_meta_json,
       total_waves, created_at, updated_at, archived_at, mission_state_json
     ) VALUES (?, ?, 'codex', '', '', '', '[]', 1, ?, ?, ?, ?)`,
  ).run(missionId, repoPath, now, now, null, JSON.stringify(state));
}

beforeEach(() => {
  h.kill.mockReset();
  h.kill.mockResolvedValue([]);
  h.archive.mockReset();
  h.archive.mockResolvedValue({ targeted: 0, archived: 0, outcomes: [], failures: [] });
  h.dispatch.mockReset();
  h.dispatch.mockImplementation(async (state: unknown) => state);
});

afterEach(() => {
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('automatic rerun admission preserves an operator stop', () => {
  it('refuses before retiring or dispatching an already stopped packet', async () => {
    const packetId = 'pkt-rerun-stop-auto';
    const repoPath = join(dataDir, 'repo-auto');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-rerun-stop-auto',
      repoPath,
      packets: [stoppedPacket({ id: packetId })],
    });
    const lane = createLane({
      repoPath,
      branch: 'inline/rerun-stop',
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
    });

    await expect(rerunWithFeedback({ packetId, feedback: 'automatic retry', preserveOperatorStop: true }))
      .rejects.toBeInstanceOf(PacketOperatorStopPreservedError);

    const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId);
    expect(packet).toMatchObject({ operatorStopped: true, queueState: 'held', blockedReason: 'operator_stopped' });
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.archive).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(listLanes().filter((candidate) => candidate.packetId === packetId).map((candidate) => candidate.id))
      .toContain(lane.id);
  }, 20_000);

  it('refuses automatic rerun for a stopped packet owned only by the mission registry', async () => {
    const packetId = 'pkt-rerun-registry-stop';
    const missionId = 'mission-rerun-registry-stop';
    const repoPath = join(dataDir, 'repo-registry');
    // No active copy for this packet: a different mission owns the control plane.
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-active-unrelated',
      packets: [],
    });
    insertRegistryMission(missionId, repoPath, [stoppedPacket({ id: packetId })]);

    await expect(rerunWithFeedback({ packetId, feedback: 'automatic retry', preserveOperatorStop: true }))
      .rejects.toBeInstanceOf(PacketOperatorStopPreservedError);

    const packet = readMissionRegistryEntry(missionId, { includeArchived: true })
      ?.mission.packets.find((candidate) => candidate.id === packetId);
    expect(packet).toMatchObject({ operatorStopped: true, queueState: 'held', blockedReason: 'operator_stopped' });
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.archive).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  }, 20_000);

  it('does not fall through to an older unstopped registry copy when the active packet is stopped', async () => {
    const packetId = 'pkt-rerun-active-stop-older';
    const missionId = 'mission-rerun-active-stop-older';
    const repoPath = join(dataDir, 'repo-active-older');
    insertRegistryMission(missionId, repoPath, [stoppedPacket({
      id: packetId,
      operatorStopped: false,
      queueState: 'queued',
      status: 'running',
      blockedReason: null,
      lastEventLabel: null,
    })]);
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-rerun-active-stop-owner',
      repoPath,
      packets: [stoppedPacket({ id: packetId })],
    });

    await expect(rerunWithFeedback({ packetId, feedback: 'automatic retry', preserveOperatorStop: true }))
      .rejects.toBeInstanceOf(PacketOperatorStopPreservedError);

    const older = readMissionRegistryEntry(missionId, { includeArchived: true })
      ?.mission.packets.find((candidate) => candidate.id === packetId);
    expect(older?.operatorStopped).not.toBe(true);
    expect(older?.queueState).toBe('queued');
    expect(older?.releaseStatePayload).toBeFalsy();
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  }, 20_000);

  it('leaves explicit manual rerun semantics unchanged', async () => {
    const packetId = 'pkt-rerun-stop-manual';
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-rerun-stop-manual',
      repoPath: join(dataDir, 'repo-manual'),
      packets: [stoppedPacket({ id: packetId, referenceLabel: 'P2' })],
    });

    const result = await rerunWithFeedback({ packetId, feedback: 'manual retry' });

    expect(result.packetId).toBe(packetId);
    const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId);
    expect(packet?.operatorStopped).not.toBe(true);
    expect(packet?.queueState).toBe('queued');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  }, 20_000);
});
