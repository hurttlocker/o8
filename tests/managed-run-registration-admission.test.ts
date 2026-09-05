import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-managed-run-admission-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const managedRunsRoute = await import('@/app/api/panel/managed-runs/route');
const { closeDb } = await import('@/lib/db');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { findManagedRun } = await import('@/lib/runtimes/managed-runs/registry');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');

function packet(status: 'running' | 'blocked', queueState: 'queued' | 'held') {
  return {
    id: 'packet-managed-run-admission',
    referenceLabel: 'PKT-ADMISSION',
    title: 'managed run admission',
    summary: 'managed run admission',
    status,
    queueState,
    releaseState: 'pending' as const,
    runtime: 'codex' as const,
    wave: 1,
    dependencyPacketIds: [],
    dependencyLabels: [],
    blockedReason: queueState === 'held' ? 'operator_stopped' : null,
    operatorStopped: queueState === 'held',
    lane: null,
    review: null,
    workspaceTargetPath: '/tmp/o8-managed-run-admission-repo',
    branchTarget: 'inline/managed-run-admission',
  };
}

function registerRequest(id: string) {
  return new Request('http://localhost/api/panel/managed-runs', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${getOrCreateWsToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      action: 'register',
      id,
      session: `cortex-run-${id}`,
      command: 'node fixture.mjs',
      cwd: '/tmp/o8-managed-run-admission-repo',
      packetId: 'packet-managed-run-admission',
      laneId: 'lane-managed-run-admission',
      mode: 'detach',
    }),
  });
}

beforeEach(() => {
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: 'mission-managed-run-admission',
    repoPath: '/tmp/o8-managed-run-admission-repo',
    packets: [packet('running', 'queued')],
  });
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('packet-bound managed-run admission', () => {
  it('registers a run while its packet is active', async () => {
    const response = await managedRunsRoute.POST(registerRequest('active123'));

    expect(response.status, await response.clone().text()).toBe(200);
    expect(findManagedRun('active123')).toMatchObject({
      packetId: 'packet-managed-run-admission',
      status: 'running',
    });
  });

  it('rejects a late registration after the packet hold is durable', async () => {
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-managed-run-admission',
      repoPath: '/tmp/o8-managed-run-admission-repo',
      packets: [packet('blocked', 'held')],
    });

    const response = await managedRunsRoute.POST(registerRequest('held1234'));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'packet_not_accepting_managed_runs',
      reason: 'packet_held',
      packetStatus: 'blocked',
    });
    expect(findManagedRun('held1234')).toBeNull();
  });
});
