import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const stopMock = vi.hoisted(() => ({
  calls: [] as string[],
  failures: new Set<string>(),
}));

vi.mock('@/lib/lane/commands', () => ({
  dispatch: vi.fn(async (command: { verb: string; laneId: string }) => {
    stopMock.calls.push(command.laneId);
    if (stopMock.failures.has(command.laneId)) {
      return {
        ok: false,
        lane: { id: command.laneId, status: 'running', lastEventLabel: 'interrupt_failed' },
        note: 'Worker remained live after SIGINT, SIGTERM, and SIGKILL.',
      };
    }
    return {
      ok: true,
      lane: { id: command.laneId, status: 'paused', lastEventLabel: 'operator_stopped' },
      note: 'Stopped.',
    };
  }),
}));

const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { writeOrchestratorControlPlaneState, readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { stopMission } = await import('@/lib/orchestrator/mission-stop');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
import type { OrchestratorLaneBinding, OrchestratorPacket } from '@/lib/orchestrator/types';

function packetFixture(
  repoPath: string,
  id: string,
  overrides: Partial<OrchestratorPacket> = {},
): OrchestratorPacket {
  return {
    id,
    referenceLabel: id.toUpperCase(),
    title: `packet ${id}`,
    summary: `packet ${id}`,
    status: 'queued',
    queueState: 'queued',
    releaseState: 'pending',
    runtime: 'codex',
    wave: 1,
    dependencyPacketIds: [],
    dependencyLabels: [],
    blockedReason: null,
    lane: null,
    review: null,
    workspaceTargetPath: repoPath,
    branchTarget: `inline/${id}`,
    ...overrides,
  } as OrchestratorPacket;
}

function laneBinding(repoPath: string, laneId: string): OrchestratorLaneBinding {
  return {
    tileId: `tile-${laneId}`,
    tabId: `tab-${laneId}`,
    repoPath,
    worktreePath: repoPath,
    runtime: 'codex',
    laneId,
    sessionKey: `codex-owned:${laneId}`,
    lastHeartbeatAt: null,
    lastEventAt: null,
    lastEventLabel: null,
  };
}

describe('stopMission', () => {
  it('fans out stop across mixed packet states and reports every outcome', async () => {
    stopMock.calls.length = 0;
    stopMock.failures.clear();

    const repoPath = mkdtempSync(join(tmpdir(), 'o8-stop-mission-'));
    const runningLane = createLane({
      repoPath,
      branch: 'inline/running',
      runtime: 'codex',
      packetId: 'running',
    });
    setLaneStatus(runningLane.id, 'running', 'system', 'test_running');

    const failedStopLane = createLane({
      repoPath,
      branch: 'inline/failed-stop',
      runtime: 'codex',
      packetId: 'failed-stop',
    });
    setLaneStatus(failedStopLane.id, 'running', 'system', 'test_running');
    stopMock.failures.add(failedStopLane.id);

    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-stop-test',
      repoPath,
      packets: [
        packetFixture(repoPath, 'running', {
          status: 'running',
          queueState: 'queued',
          lane: laneBinding(repoPath, runningLane.id),
        }),
        packetFixture(repoPath, 'queued-never-launched'),
        packetFixture(repoPath, 'already-terminal', {
          status: 'awaiting_review',
          queueState: 'held',
        }),
        packetFixture(repoPath, 'failed-stop', {
          status: 'running',
          queueState: 'queued',
          lane: laneBinding(repoPath, failedStopLane.id),
        }),
      ],
    });

    const result = await stopMission('mission-stop-test');

    expect(stopMock.calls).toEqual([runningLane.id, failedStopLane.id]);
    expect(result.packets).toEqual([
      {
        packetId: 'running',
        status: 'stopped',
        laneId: runningLane.id,
        note: 'Stopped.',
      },
      {
        packetId: 'queued-never-launched',
        status: 'stopped',
        laneId: null,
        note: 'Queued packet held before any lane launched.',
      },
      {
        packetId: 'already-terminal',
        status: 'already-terminal',
        laneId: null,
        note: 'Packet is already terminal (awaiting_review).',
      },
      {
        packetId: 'failed-stop',
        status: 'stop-failed',
        laneId: failedStopLane.id,
        note: 'Worker remained live after SIGINT, SIGTERM, and SIGKILL.',
      },
    ]);

    const persisted = readOrchestratorControlPlaneState();
    expect(persisted.packets.map((packet) => ({
      id: packet.id,
      status: packet.status,
      queueState: packet.queueState,
      operatorStopped: packet.operatorStopped,
      lastEventLabel: packet.lastEventLabel,
    }))).toEqual([
      {
        id: 'running',
        status: 'blocked',
        queueState: 'held',
        operatorStopped: true,
        lastEventLabel: 'operator_stopped',
      },
      {
        id: 'queued-never-launched',
        status: 'blocked',
        queueState: 'held',
        operatorStopped: true,
        lastEventLabel: 'operator_stopped',
      },
      {
        id: 'already-terminal',
        status: 'awaiting_review',
        queueState: 'held',
        operatorStopped: undefined,
        lastEventLabel: undefined,
      },
      {
        id: 'failed-stop',
        status: 'running',
        queueState: 'queued',
        operatorStopped: undefined,
        lastEventLabel: undefined,
      },
    ]);
  });
});
