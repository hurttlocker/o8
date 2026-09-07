import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const perform = vi.hoisted(() => vi.fn());
vi.mock('@/lib/runtime/actions', () => ({ performRuntimeAction: perform }));
vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: vi.fn(async () => ({ agents: [] })),
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));

const dataDir = mkdtempSync(join(tmpdir(), 'o8-steer-run-admission-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
const { closeDb } = await import('@/lib/db');
const { createLane, getLane, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { findManagedRun } = await import('@/lib/runtimes/managed-runs/registry');
const steerRoute = await import('@/app/api/orchestrator/steer-packet/route');
const runsRoute = await import('@/app/api/panel/managed-runs/route');

let sequence = 0;
function fixture(operatorStopped = false) {
  const id = `pkt-steer-runs-${++sequence}`;
  const repoPath = join(dataDir, id);
  const sessionKey = `claude-code-owned:${id}`;
  const lane = createLane({
    repoPath, worktreePath: repoPath, branch: `inline/${id}`, runtime: 'claude-code',
    packetId: id, sessionKey,
  });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
  const packet: OrchestratorPacket = {
    id, referenceLabel: id, title: id, summary: id, runtime: 'claude-code',
    workspaceTargetPath: repoPath, branchTarget: `inline/${id}`,
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'held',
    releaseState: 'pending', status: 'awaiting_review', operatorStopped,
    blockedReason: operatorStopped ? 'operator_stopped' : null,
    lastEventAt: null, lastEventLabel: null, archivedAt: null, review: null,
    lane: { tileId: lane.id, tabId: lane.id, laneId: lane.id, repoPath,
      worktreePath: repoPath, runtime: 'claude-code', sessionKey },
  };
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${id}`, repoPath, packets: [packet] });
  perform.mockResolvedValue({ ok: true, status: 'accepted', sessionKey, note: 'accepted' });
  return { packet, lane, sessionKey };
}

function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, { method: 'POST', headers: {
    authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json',
  }, body: JSON.stringify(body) });
}
function steer(packetId: string) {
  return steerRoute.POST(request('/api/orchestrator/steer-packet', {
    packetId, message: 'Run the remaining verification', idempotencyKey: `steer-${packetId}`,
  }));
}
function register(packet: OrchestratorPacket, suffix = 'first') {
  const id = `run${sequence}${suffix}`;
  return runsRoute.POST(request('/api/panel/managed-runs', {
    id, session: `cortex-run-${id}`, command: 'node --version',
    cwd: packet.workspaceTargetPath, packetId: packet.id, laneId: packet.lane?.laneId,
  }));
}

beforeEach(() => perform.mockReset());
afterAll(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

describe('steered-turn managed-run admission through production routes', () => {
  it.each(['awaiting_review', 'released'] as const)('admits an accepted %s turn across reopen, then refuses its exit', async (priorStatus) => {
    const { packet, lane, sessionKey } = fixture();
    if (priorStatus === 'released') {
      // Legacy completion stamped release without canonical merge evidence.
      packet.status = 'released';
      packet.releaseState = 'released';
      writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
        missionId: `mission-${packet.id}`, repoPath: packet.workspaceTargetPath, packets: [packet] });
    }
    expect((await register(packet, 'before')).status).toBe(409);
    const response = await steer(packet.id);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(getLane(lane.id)?.status).toBe('running');
    closeDb();
    const admitted = await register(packet);
    expect(admitted.status, await admitted.clone().text()).toBe(200);
    expect(findManagedRun(`run${sequence}first`)?.packetId).toBe(packet.id);
    // The normal reconciler may already have projected the active turn.
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
      missionId: `mission-${packet.id}`, repoPath: packet.workspaceTargetPath,
      packets: [{ ...packet, status: 'running', queueState: 'queued' }] });
    recordLaneEvent(lane.id, 'runtime_process_exit', 'system', {
      surfaceId: sessionKey, exitCode: 0, classification: 'clean-exit',
    });
    expect((await register(packet, 'late')).status).toBe(409);
    expect(findManagedRun(`run${sequence}late`)).toBeNull();
  });

  it('does not grant admission when the runtime refuses the steer', async () => {
    const { packet } = fixture();
    perform.mockResolvedValue({ ok: false, status: 'unavailable', note: 'no warm session' });
    expect((await steer(packet.id)).status).toBe(409);
    expect((await register(packet)).status).toBe(409);
  });

  it('does not resume or admit an operator-stopped packet', async () => {
    const { packet } = fixture(true);
    expect((await steer(packet.id)).status).toBe(409);
    expect(perform).not.toHaveBeenCalled();
    expect((await register(packet)).status).toBe(409);
  });

  it('keeps a concurrent operator hold authoritative after runtime acceptance', async () => {
    const { packet } = fixture();
    perform.mockImplementation(async () => {
      const { persistLanePacketHold } = await import('@/lib/lane/packet-stop-hold');
      await persistLanePacketHold(packet.id);
      return { ok: true, status: 'accepted', note: 'accepted' };
    });
    expect((await steer(packet.id)).status).toBe(409);
    expect((await register(packet)).status).toBe(409);
  });

  it('does not carry admission into a rebound session', async () => {
    const { packet, lane } = fixture();
    expect((await steer(packet.id)).status).toBe(200);
    expect((await register(packet)).status).toBe(200);
    updateLane(lane.id, { sessionKey: 'claude-code-owned:unaccepted-successor' });
    expect((await register(packet, 'rebound')).status).toBe(409);
  });

  it.each(['archived', 'released'] as const)('does not steer a %s packet', async (state) => {
    const { packet } = fixture();
    if (state === 'archived') {
      packet.status = 'archived';
      packet.archivedAt = new Date().toISOString();
    } else {
      const { markPacketReleased } = await import('@/lib/orchestrator/packet-release-truth');
      markPacketReleased(packet, { source: 'read_only_completed' });
    }
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
      missionId: `mission-${packet.id}`, repoPath: packet.workspaceTargetPath, packets: [packet] });
    expect((await steer(packet.id)).status).toBe(409);
    expect(perform).not.toHaveBeenCalled();
    expect((await register(packet)).status).toBe(409);
  });

  it('does not grant an unrelated session rebound during runtime acceptance', async () => {
    const { packet, lane, sessionKey } = fixture();
    perform.mockImplementation(async () => {
      updateLane(lane.id, { sessionKey: 'claude-code-owned:unaccepted-successor' });
      return { ok: true, status: 'accepted', sessionKey, note: 'accepted original turn' };
    });
    expect((await steer(packet.id)).status).toBe(409);
    expect((await register(packet)).status).toBe(409);
  });

  it('does not admit a turn that exits before the steer response', async () => {
    const { packet, lane, sessionKey } = fixture();
    perform.mockImplementation(async () => {
      recordLaneEvent(lane.id, 'runtime_process_exit', 'system', {
        surfaceId: sessionKey, exitCode: 0, classification: 'clean-exit',
      });
      return { ok: true, status: 'accepted', sessionKey, note: 'finished immediately' };
    });
    expect((await steer(packet.id)).status).toBe(200);
    expect((await register(packet)).status).toBe(409);
  });
});
