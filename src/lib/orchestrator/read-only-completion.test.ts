import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-read-only-completion-'));

const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const {
  completeReadOnlyZeroDiffLane,
  READ_ONLY_COMPLETED_EVENT_LABEL,
} = await import('./read-only-completion');
import type { OrchestratorPacket } from './types';

function packet(packetId: string, readOnly: boolean): OrchestratorPacket {
  return {
    id: packetId,
    referenceLabel: packetId.toUpperCase(),
    title: `packet ${packetId}`,
    summary: `packet ${packetId}`,
    status: 'running',
    queueState: 'queued',
    releaseState: 'pending',
    runtime: 'opencode',
    wave: 1,
    dependencyPacketIds: [],
    dependencyLabels: [],
    blockedReason: null,
    lane: null,
    review: null,
    workspaceTargetPath: '/tmp/o8-read-only-completion-repo',
    branchTarget: `inline/${packetId}`,
    launchContext: {
      source: 'cli',
      presentation: 'split',
      repoContext: 'transient',
      ...(readOnly ? { workMode: 'read-only' as const } : {}),
    },
  } as OrchestratorPacket;
}

function seed(packetId: string, readOnly: boolean) {
  const lane = createLane({
    repoPath: '/tmp/o8-read-only-completion-repo',
    branch: `inline/${packetId}`,
    baseBranch: 'main',
    runtime: 'opencode',
    packetId,
    sessionKey: `opencode-owned:${packetId}`,
  });
  setLaneStatus(lane.id, 'running', 'system', 'session_running');
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    packets: [packet(packetId, readOnly)],
  });
  return getLane(lane.id)!;
}

describe('read-only zero-diff completion', () => {
  it('releases an explicitly read-only packet instead of failing it', async () => {
    const lane = seed('pkt-read-only', true);

    const result = await completeReadOnlyZeroDiffLane(lane);

    expect(result.completed).toBe(true);
    expect(getLane(lane.id)).toMatchObject({
      status: 'completed',
      outcome: 'no_changes',
      lastEventLabel: READ_ONLY_COMPLETED_EVENT_LABEL,
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'released',
      queueState: 'held',
      releaseState: 'released',
      blockedReason: null,
      lastEventLabel: READ_ONLY_COMPLETED_EVENT_LABEL,
    });
  });

  it('leaves ordinary edit packets on the existing zero-diff path', async () => {
    const lane = seed('pkt-edit', false);

    expect(await completeReadOnlyZeroDiffLane(lane)).toEqual({ completed: false });
    expect(getLane(lane.id)?.status).toBe('running');
  });
});
