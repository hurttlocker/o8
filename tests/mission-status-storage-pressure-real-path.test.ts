import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-mission-storage-pressure-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const statusRoute = await import('@/app/api/orchestrator/status/route');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('mission status storage-pressure projection', () => {
  it('projects the durable pressure decision receipt through the mission service entry', async () => {
    const packet: OrchestratorPacket = {
      id: 'packet-pressure-status',
      referenceLabel: 'PKT-PRESSURE-STATUS',
      title: 'pressure status',
      summary: 'pressure status',
      workspaceTargetPath: dataDir,
      branchTarget: 'inline/pressure-status',
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'queued',
      releaseState: 'pending',
      status: 'running',
      lane: null,
      storageAdmission: {
        schema: 'o8/packet-storage-admission/v1',
        state: 'committed',
        reason: 'committed',
        reservationId: 'reservation-status',
        mutationId: 'mutation-status',
        ownerId: 'packet-pressure-status',
        ownerGeneration: 1,
        estimateBytes: 512,
        estimateSource: 'same-repo-history',
        historySamples: 1,
        volumeId: 'volume-status',
        physicalAvailableBytes: 8_192,
        reservedBeforeBytes: 0,
        requiredReserveBytes: 1_024,
        dispatchHeadroomBytes: 7_168,
        pressure: {
          schema: 'o8/storage-pressure-decision/v1',
          mode: 'pressure',
          status: 'admitted_after_parking',
          trigger: 'reserve_breached',
          launchGeneration: 1,
          recordedAt: Date.parse('2026-08-15T00:00:00.000Z'),
          candidates: [{
            packetId: 'reviewing-candidate',
            repositoryUuid: 'repo-status',
            laneId: 'lane-status',
            operationId: 'pressure-operation-status',
            workspacePath: '/tmp/o8-status-candidate',
            measuredAllocatedBytes: 4_096,
            verifiedReclaimedAvailableBytes: 4_096,
            outcome: 'parked',
            reason: 'parked',
          }],
        },
        recordedAt: Date.parse('2026-08-15T00:00:00.000Z'),
      },
    };
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-pressure-status',
      repoPath: dataDir,
      runtime: 'codex',
      packets: [packet],
    });

    const response = await statusRoute.GET(new NextRequest(
      'http://127.0.0.1/api/orchestrator/status?missionId=mission-pressure-status',
      { headers: { Host: '127.0.0.1' } },
    ));
    const body = await response.json() as {
      result: { packets: Array<{ storageAdmission: OrchestratorPacket['storageAdmission'] }> };
    };

    expect(response.status).toBe(200);
    expect(body.result.packets[0]?.storageAdmission).toEqual(packet.storageAdmission);
  });
});
