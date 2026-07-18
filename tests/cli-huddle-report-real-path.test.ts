import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-cli-huddle-report-'));
const workerToken = 'local-worker-token-huddle-report-0123456789';
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'worker-token'), `${workerToken}\n`, 'utf-8');
writeFileSync(join(dataDir, 'ws-token'), 'operator-huddle-report-token-0123456789\n', 'utf-8');

const { parseReportArgs } = await import('../cli/src/commands/packet/report');
const laneEventsRoute = await import('@/app/api/lanes/[id]/events/route');
const { createLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { getMissionStatus } = await import('@/lib/orchestrator/operator-mission-service');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function workerReportRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3001/api/lanes/lane/events', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${workerToken}`,
    },
    body: JSON.stringify(body),
  });
}

describe('#1495 huddle packet report real path', () => {
  it('the taught --event huddle command persists a typed event and parks the packet for the orchestrator', async () => {
    const packetId = 'pkt-huddle-report-real-path';
    const repoPath = join(dataDir, 'repo');
    const sessionKey = `codex-owned:${packetId}`;
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'agent/huddle-report-real-path',
      baseBranch: 'main',
      runtime: 'codex',
      sessionKey,
      packetId,
      label: 'Huddle report real path',
    });
    const packet = {
      id: packetId,
      referenceLabel: 'PKT-HUDDLE',
      title: 'Plan before implementation',
      summary: 'The worker must stop after reporting its huddle plan.',
      workspaceTargetPath: repoPath,
      branchTarget: 'main',
      status: 'running',
      queueState: 'queued',
      releaseState: 'pending',
      blockedReason: null,
      lane: {
        tileId: lane.id,
        tabId: lane.id,
        repoPath,
        worktreePath: repoPath,
        runtime: 'codex',
        sessionKey,
        laneId: lane.id,
        lastHeartbeatAt: null,
        lastEventAt: null,
        lastEventLabel: null,
      },
      review: null,
      runtime: 'codex',
      dependencyPacketIds: [],
      dependencyLabels: [],
      huddle: true,
    } as OrchestratorPacket;
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-huddle-report-real-path',
      repoPath,
      runtime: 'codex',
      packets: [packet],
      updatedAt: new Date().toISOString(),
    });

    const plan = 'Plan: inspect the report seam, align the enum, then verify the persisted transition.';
    const parsed = parseReportArgs([
      packetId,
      '--event',
      'huddle',
      '--message',
      plan,
    ]);
    expect(parsed).toMatchObject({
      packetId,
      event: 'huddle',
      reason: null,
      message: plan,
    });

    const response = await laneEventsRoute.POST(
      workerReportRequest({
        verb: 'agent_report',
        event: parsed.event,
        message: parsed.message,
      }),
      { params: Promise.resolve({ id: lane.id }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      statusChanged: true,
      lane: { id: lane.id, packetId, status: 'awaiting_orchestrator', lastEventLabel: 'huddle' },
      event: {
        verb: 'agent_report',
        payload: { packetId, event: 'huddle', message: plan },
      },
    });

    const persistedEvent = getLaneEvents(lane.id)
      .find((event) => event.id === body.event.id);
    expect(persistedEvent).toMatchObject({
      verb: 'agent_report',
      payload: { packetId, event: 'huddle', message: plan },
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'awaiting_orchestrator',
      lastEventLabel: 'huddle',
    });

    const missionStatus = await getMissionStatus({
      missionId: 'mission-huddle-report-real-path',
      includeCost: false,
    });
    const persistedPacket = missionStatus.packets
      .find((candidate) => candidate.id === packetId);
    expect(persistedPacket).toMatchObject({
      status: 'blocked',
      blockedReason: 'huddle',
      lane: {
        status: 'awaiting_orchestrator',
        lastEventLabel: 'huddle',
      },
    });
  });

  it('the report route rejects events outside the packet-report enum', async () => {
    const response = await laneEventsRoute.POST(
      workerReportRequest({ verb: 'agent_report', event: 'made_up_event' }),
      { params: Promise.resolve({ id: 'lane-does-not-matter' }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      note: 'Invalid packet report event.',
    });
  });
});
