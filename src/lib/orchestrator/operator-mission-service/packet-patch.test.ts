import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-packet-patch-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { patchMissionPacket } = await import('./packet-patch');

function packet(id: string, title: string): OrchestratorPacket {
  return {
    id,
    referenceLabel: id,
    title,
    summary: title,
    workspaceTargetPath: '/tmp/o8-packet-patch-repo',
    branchTarget: `agent/${id}`,
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    attemptCount: 0,
    maxAttempts: 3,
    blockedReason: null,
    lastEventAt: '2026-08-13T00:00:00.000Z',
    lastEventLabel: 'task_created',
    archivedAt: null,
    review: null,
    lane: null,
  };
}

describe('patchMissionPacket', () => {
  it('preserves a packet added by another process after this process cached mission state', async () => {
    const alpha = packet('pkt-alpha', 'Alpha');
    const beta = packet('pkt-beta', 'Beta');
    const initial = {
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-packet-patch',
      packets: [alpha],
    };
    writeOrchestratorControlPlaneState(initial);

    writeFileSync(
      join(dataDir, 'orchestrator-state.json'),
      `${JSON.stringify({ version: 1, mission: { ...initial, packets: [alpha, beta] } }, null, 2)}\n`,
      'utf8',
    );

    await expect(patchMissionPacket(alpha.id, { title: 'Alpha updated' })).resolves.toBe(true);

    const persisted = readOrchestratorControlPlaneState();
    expect(persisted.packets.map((entry) => entry.id)).toEqual([alpha.id, beta.id]);
    expect(persisted.packets[0]?.title).toBe('Alpha updated');
  });
});
