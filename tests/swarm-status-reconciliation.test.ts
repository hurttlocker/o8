import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-swarm-status-reconciliation-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const stateRoute = await import('@/app/api/orchestrator/state/route');
const { createLane, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { SwarmStatusCard } = await import('@/components/desktop/thoughts/chat-panel/SwarmStatusCard');

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function packetFixture(packetId: string, laneId: string): OrchestratorPacket {
  return {
    id: packetId,
    referenceLabel: packetId.toUpperCase(),
    title: `Packet ${packetId}`,
    summary: 'Exercise terminal status reconciliation.',
    workspaceTargetPath: null,
    branchTarget: `packet/${packetId}`,
    runtime: 'qoder',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'running',
    blockedReason: null,
    lane: {
      tileId: '',
      tabId: '',
      repoPath: dataDir,
      runtime: 'qoder',
      sessionKey: `qoder-owned:${packetId}`,
      laneId,
      lastHeartbeatAt: null,
      lastEventAt: '2026-07-29T10:00:00.000Z',
      lastEventLabel: 'session_launched',
    },
    review: null,
  };
}

function persistStaleMission(packet: OrchestratorPacket): void {
  writeOrchestratorControlPlaneState({
    version: 2,
    missionId: `mission-${packet.id}`,
    prompt: 'Exercise packet status truth.',
    summary: 'Exercise packet status truth.',
    repoPath: dataDir,
    runtime: 'codex',
    constraints: '',
    packets: [packet],
    activeComparisonGroups: [],
    updatedAt: new Date().toISOString(),
  } satisfies OrchestratorMissionState);
}

async function readMissionPacket(packetId: string): Promise<OrchestratorPacket> {
  const response = await stateRoute.GET(new NextRequest(
    'http://localhost:3001/api/orchestrator/state',
    { headers: { host: 'localhost:3001' } },
  ));
  expect(response.status).toBe(200);
  const body = await response.json() as { mission: OrchestratorMissionState };
  const packet = body.mission.packets.find((candidate) => candidate.id === packetId);
  expect(packet).toBeTruthy();
  return packet!;
}

function renderCard(packet: OrchestratorPacket): string {
  return renderToStaticMarkup(createElement(SwarmStatusCard, { packets: [packet] }));
}

describe('#1635 swarm status reconciliation', () => {
  it('renders a persisted terminal lane as Failed despite a stale session_launched event', async () => {
    const packetId = 'pkt-terminal-stale-event';
    const lane = createLane({
      repoPath: dataDir,
      branch: `packet/${packetId}`,
      runtime: 'qoder',
      packetId,
      sessionKey: `qoder-owned:${packetId}`,
    });
    setLaneStatus(lane.id, 'running', 'system', 'session_launched');
    updateLane(lane.id, {
      status: 'failed',
      lastEventLabel: 'session_launched',
    });
    persistStaleMission(packetFixture(packetId, lane.id));

    const packet = await readMissionPacket(packetId);
    const markup = renderCard(packet);

    expect(packet.status).toBe('failed');
    expect(markup).toContain('Failed');
    expect(markup).not.toContain('Running');
  });

  it('maps a newer runtime_process_exit event to Failed on the real state read', async () => {
    const packetId = 'pkt-runtime-process-exit';
    const lane = createLane({
      repoPath: dataDir,
      branch: `packet/${packetId}`,
      runtime: 'qoder',
      packetId,
      sessionKey: `qoder-owned:${packetId}`,
    });
    setLaneStatus(lane.id, 'running', 'system', 'session_launched');
    persistStaleMission(packetFixture(packetId, lane.id));
    recordLaneEvent(lane.id, 'runtime_process_exit', 'system', {
      runtime: 'qoder',
      exitCode: 23,
      signal: null,
      classification: 'nonzero-exit',
      completedTurn: false,
    });

    const packet = await readMissionPacket(packetId);
    const markup = renderCard(packet);

    expect(packet.status).toBe('failed');
    expect(packet.blockedReason).toBe('runtime_process_exit');
    expect(markup).toContain('Failed');
    expect(markup).toContain('runtime_process_exit');
    expect(markup).not.toContain('Running');
  });

  it('repairs a stale process-exit failure when the owned runtime completed cleanly', async () => {
    const packetId = 'pkt-runtime-clean-exit';
    const lane = createLane({
      repoPath: dataDir,
      branch: `packet/${packetId}`,
      runtime: 'qoder',
      packetId,
      sessionKey: `qoder-owned:${packetId}`,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');
    persistStaleMission({
      ...packetFixture(packetId, lane.id),
      status: 'failed',
      blockedReason: 'runtime_process_exit',
    });
    recordLaneEvent(lane.id, 'runtime_process_exit', 'system', {
      runtime: 'qoder',
      exitCode: 0,
      signal: null,
      classification: 'clean-exit',
      completedTurn: true,
    });

    const packet = await readMissionPacket(packetId);
    const markup = renderCard(packet);

    expect(packet.status).toBe('awaiting_review');
    expect(packet.blockedReason).toBeNull();
    expect(markup).not.toContain('Failed');
  });
});
