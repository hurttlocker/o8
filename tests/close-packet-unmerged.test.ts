import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-close-unmerged-'));
const wsToken = 'operator-close-unmerged-token-0123456789';
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'ws-token'), `${wsToken}\n`, 'utf-8');

const closeRoute = await import('@/app/api/orchestrator/discard-packet/route');
const { getDb, closeDb } = await import('@/lib/db');
const { sessionOutcomes } = await import('@/lib/db/schema');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function operatorRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3001/api/orchestrator/discard-packet', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${wsToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('close_packet_unmerged real path (#1570)', () => {
  it('archives an awaiting-review packet and writes the explicit disposition to durable state', async () => {
    const packetId = 'pkt-close-unmerged-real-path';
    const repoPath = join(dataDir, 'repo');
    const lane = createLane({
      repoPath,
      branch: 'issue/close-unmerged',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'Close unmerged real path',
      packetId,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');

    const packet = {
      id: packetId,
      referenceLabel: '#1570',
      title: 'Close packet unmerged',
      summary: 'This work moved to another repository.',
      workspaceTargetPath: repoPath,
      branchTarget: 'main',
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'pending',
      status: 'awaiting_review',
      blockedReason: null,
      lane: {
        tileId: lane.id,
        tabId: lane.id,
        repoPath,
        runtime: 'codex',
        laneId: lane.id,
      },
      review: null,
    } as OrchestratorPacket;
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-close-unmerged-real-path',
      repoPath,
      runtime: 'codex',
      packets: [packet],
      updatedAt: new Date().toISOString(),
    });

    const db = getDb();
    expect(db).not.toBeNull();

    const response = await closeRoute.POST(operatorRequest({
      packetId,
      disposition: 'adopted_elsewhere',
      note: 'Implemented in o8-mobile.',
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      result: {
        closed: true,
        disposition: 'adopted_elsewhere',
        packetId,
      },
    });

    expect(getLane(lane.id)).toMatchObject({
      status: 'archived',
      outcome: 'closed_unmerged',
      outcomeNote: expect.stringContaining('Adopted elsewhere'),
    });
    const persistedPacket = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId);
    expect(persistedPacket).toMatchObject({
      status: 'archived',
      queueState: 'held',
      lastEventLabel: 'closed_unmerged',
    });
    expect(persistedPacket?.archivedAt).toEqual(expect.any(String));

    const outcome = await db!
      .select({
        outcome: sessionOutcomes.outcome,
        summary: sessionOutcomes.summary,
        mergedClean: sessionOutcomes.mergedClean,
      })
      .from(sessionOutcomes)
      .where(eq(sessionOutcomes.packetId, packetId))
      .get();
    expect(outcome).toEqual({
      outcome: 'adopted_elsewhere',
      summary: expect.stringContaining('Implemented in o8-mobile.'),
      mergedClean: false,
    });
  });
});
