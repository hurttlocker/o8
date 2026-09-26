import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket, OrchestratorPacketStorageAdmission } from '@/lib/orchestrator/types';

vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: vi.fn(async () => ({ agents: [], runtimes: [] })),
}));

const dataDir = mkdtempSync(join(tmpdir(), 'o8-storage-client-write-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const { closeDb } = await import('@/lib/db');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { getDispatchableWave } = await import('@/lib/orchestrator/dag');
const { markPacketReleased } = await import('@/lib/orchestrator/packet-release-truth');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const stateRoute = await import('@/app/api/orchestrator/state/route');
const statusRoute = await import('@/app/api/orchestrator/status/route');

function admission(ownerGeneration: number, state: 'held' | 'committed'): OrchestratorPacketStorageAdmission {
  return {
    schema: 'o8/packet-storage-admission/v1',
    state,
    reason: state === 'held' ? 'reserve_breached' : 'committed',
    reservationId: `packet-storage:pkt-storage-client:${ownerGeneration}`,
    mutationId: `packet-storage-${state}:pkt-storage-client:${ownerGeneration}`,
    ownerId: 'pkt-storage-client',
    ownerGeneration,
    estimateBytes: 2_147_483_648,
    estimateSource: 'source-size-fallback',
    historySamples: 0,
    volumeId: 'test-volume',
    physicalAvailableBytes: 60_000_000_000,
    reservedBeforeBytes: 0,
    requiredReserveBytes: 50_000_000_000,
    dispatchHeadroomBytes: state === 'held' ? -1 : 8_000_000_000,
    recordedAt: ownerGeneration,
  };
}

function request(method: 'GET' | 'POST', path: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      authorization: `Bearer ${getOrCreateWsToken()}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('server lifecycle after a stale dashboard mission POST', () => {
  it('keeps committed admission and canonical release through the real state and status routes', async () => {
    const packet: OrchestratorPacket = {
      id: 'pkt-storage-client', referenceLabel: 'storage', title: 'inspect', summary: 'inspect',
      workspaceTargetPath: dataDir, branchTarget: 'inline/storage', runtime: 'codex',
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued',
      releaseState: 'pending', status: 'queued', blockedReason: null, lane: null, review: null,
      storageAdmission: admission(1, 'held'), storageAdmissionEpoch: 1,
    };
    const cached = writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(), missionId: 'mission-storage-client',
      repoPath: dataDir, packets: [packet],
    });

    writeOrchestratorControlPlaneState({
      ...cached,
      packets: [{ ...packet, status: 'blocked', queueState: 'held',
        blockedReason: 'Operator hold after admission', storageAdmission: admission(2, 'committed') }],
    });
    const response = await stateRoute.POST(request('POST', '/api/orchestrator/state', {
      mission: { ...cached, packets: [{ ...cached.packets[0]!, title: 'renamed in browser' }] },
    }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      title: 'renamed in browser',
      status: 'blocked', queueState: 'held', releaseState: 'pending',
      blockedReason: 'Operator hold after admission',
      storageAdmission: { state: 'committed', ownerGeneration: 2 },
    });
    expect(getDispatchableWave(readOrchestratorControlPlaneState().packets)).toEqual([]);

    const completed = readOrchestratorControlPlaneState();
    markPacketReleased(completed.packets[0]!, { source: 'read_only_completed' });
    writeOrchestratorControlPlaneState(completed);
    const replay = await stateRoute.POST(request('POST', '/api/orchestrator/state', { mission: cached }));
    expect(replay.status, await replay.clone().text()).toBe(200);
    const status = await statusRoute.GET(request('GET', '/api/orchestrator/status?missionId=mission-storage-client'));
    expect(status.status, await status.clone().text()).toBe(200);
    const body = await status.json();
    expect(body.result.packets[0]).toMatchObject({
      title: 'renamed in browser',
      status: 'released', queueState: 'held',
      releaseState: 'released',
      storageAdmission: { state: 'committed', ownerGeneration: 2 },
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      releaseStatePayload: { source: 'read_only_completed' },
    });
  });

  it('still reports a current storage hold when no launch occurred', async () => {
    const packet: OrchestratorPacket = {
      id: 'pkt-storage-client', referenceLabel: 'storage', title: 'inspect', summary: 'inspect',
      workspaceTargetPath: dataDir, branchTarget: 'inline/storage', runtime: 'codex',
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued',
      releaseState: 'pending', status: 'queued',
      blockedReason: 'Free space before dispatch.', lane: null, review: null,
      storageAdmission: admission(3, 'held'), storageAdmissionEpoch: 1,
    };
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(), missionId: 'mission-storage-client-held',
      repoPath: dataDir, packets: [packet],
    });
    const status = await statusRoute.GET(request('GET', '/api/orchestrator/status?missionId=mission-storage-client-held'));
    expect(status.status, await status.clone().text()).toBe(200);
    const body = await status.json();
    expect(body.result.packets[0]).toMatchObject({
      storageAdmission: { state: 'held', ownerGeneration: 3 },
      blockedReason: 'Free space before dispatch.',
      lane: null,
    });
  });

  it('drops a stale metadata edit after a server reset advanced the admission epoch', async () => {
    const packet: OrchestratorPacket = {
      id: 'pkt-storage-client', referenceLabel: 'storage', title: 'before reset', summary: 'inspect',
      workspaceTargetPath: dataDir, branchTarget: 'inline/storage', runtime: 'codex',
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued',
      releaseState: 'pending', status: 'queued', blockedReason: null, lane: null, review: null,
      storageAdmission: admission(1, 'held'), storageAdmissionEpoch: 1,
    };
    const cached = writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(), missionId: 'mission-storage-client-reset',
      repoPath: dataDir, packets: [packet],
    });
    writeOrchestratorControlPlaneState({ ...cached, packets: [{
      ...packet, title: 'after reset', status: 'blocked', queueState: 'held',
      storageAdmission: null, storageAdmissionEpoch: 2,
    }] });
    const response = await stateRoute.POST(request('POST', '/api/orchestrator/state', {
      mission: { ...cached, packets: [{ ...packet, title: 'stale browser edit' }] },
    }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      title: 'after reset', status: 'blocked', queueState: 'held', storageAdmissionEpoch: 2,
    });
  });
});
