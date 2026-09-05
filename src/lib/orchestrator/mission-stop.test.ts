import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const stopMock = vi.hoisted(() => ({
  calls: [] as string[],
  failures: new Set<string>(),
  throws: new Set<string>(),
  gate: null as Promise<void> | null,
}));
const managedRunMock = vi.hoisted(() => ({
  calls: [] as string[],
  receipt: { targeted: 0, confirmed: 0, failures: [] as Array<Record<string, unknown>> },
}));

vi.mock('@/lib/lane/commands', () => ({
  dispatch: vi.fn(async (command: { verb: string; laneId: string }) => {
    stopMock.calls.push(command.laneId);
    if (stopMock.gate) await stopMock.gate;
    if (stopMock.throws.has(command.laneId)) throw new Error('fixture stop command failure');
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
vi.mock('@/lib/runtimes/managed-runs/packet-lifecycle', () => ({
  terminatePacketManagedRuns: vi.fn(async (packetId: string) => {
    managedRunMock.calls.push(packetId);
    return managedRunMock.receipt;
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
  beforeEach(() => {
    stopMock.throws.clear();
    managedRunMock.calls.length = 0;
    managedRunMock.receipt = { targeted: 0, confirmed: 0, failures: [] };
  });

  it('fans out stop across mixed packet states and reports every outcome', async () => {
    stopMock.calls.length = 0;
    stopMock.failures.clear();
    stopMock.gate = null;

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
    expect(managedRunMock.calls).toEqual(['already-terminal']);
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
        status: 'blocked',
        queueState: 'held',
        operatorStopped: undefined,
        lastEventLabel: null,
      },
      {
        id: 'failed-stop',
        status: 'running',
        queueState: 'queued',
        operatorStopped: undefined,
        lastEventLabel: null,
      },
    ]);
  });

  it('settles packet-managed runs even when the packet is already terminal', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-stop-terminal-runs-'));
    managedRunMock.receipt = { targeted: 1, confirmed: 1, failures: [] };
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-stop-terminal-runs',
      repoPath,
      packets: [packetFixture(repoPath, 'terminal-runs', {
        status: 'archived',
        queueState: 'held',
        releaseState: 'released',
      })],
    });

    const result = await stopMission('mission-stop-terminal-runs');

    expect(managedRunMock.calls).toEqual(['terminal-runs']);
    expect(result.packets).toEqual([{
      packetId: 'terminal-runs',
      status: 'already-terminal',
      laneId: null,
      note: 'Packet is already terminal (archived). Stopped 1 packet-managed run.',
    }]);
  });

  it('reports an incomplete mission stop when a terminal packet run survives', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-stop-terminal-run-failure-'));
    managedRunMock.receipt = {
      targeted: 1,
      confirmed: 0,
      failures: [{ id: 'run-stubborn', reason: 'termination_unconfirmed' }],
    };
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-stop-terminal-run-failure',
      repoPath,
      packets: [packetFixture(repoPath, 'terminal-run-failure', {
        status: 'archived',
        queueState: 'held',
        releaseState: 'released',
      })],
    });

    const result = await stopMission('mission-stop-terminal-run-failure');

    expect(result.packets).toEqual([expect.objectContaining({
      packetId: 'terminal-run-failure',
      status: 'stop-failed',
      note: expect.stringContaining('could not be confirmed dead'),
    })]);
  });

  it('stops an awaiting-review packet when its lane still owns a live session', async () => {
    stopMock.calls.length = 0;
    stopMock.failures.clear();
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-stop-review-live-'));
    const lane = createLane({
      repoPath,
      branch: 'inline/review-live',
      runtime: 'codex',
      packetId: 'review-live',
      sessionKey: 'codex-owned:review-live',
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'test_reviewing');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-stop-review-live',
      repoPath,
      packets: [packetFixture(repoPath, 'review-live', {
        status: 'awaiting_review',
        queueState: 'held',
        lane: laneBinding(repoPath, lane.id),
      })],
    });

    const result = await stopMission('mission-stop-review-live');

    expect(stopMock.calls).toEqual([lane.id]);
    expect(result.packets).toEqual([expect.objectContaining({
      packetId: 'review-live',
      status: 'stopped',
      laneId: lane.id,
    })]);
  });

  it('rejects a queued second mission-stop intent for the same packet', async () => {
    stopMock.calls.length = 0;
    stopMock.failures.clear();
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-stop-mission-race-'));
    const lane = createLane({
      repoPath,
      branch: 'inline/stop-race',
      runtime: 'codex',
      packetId: 'stop-race',
    });
    setLaneStatus(lane.id, 'running', 'system', 'test_running');
    const missionState = {
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-stop-race',
      repoPath,
      packets: [packetFixture(repoPath, 'stop-race', {
        status: 'running',
        queueState: 'queued',
        lane: laneBinding(repoPath, lane.id),
      })],
    };
    writeOrchestratorControlPlaneState(missionState);
    let release!: () => void;
    stopMock.gate = new Promise<void>((resolve) => { release = resolve; });

    const first = stopMission('mission-stop-race');
    await vi.waitFor(() => expect(stopMock.calls).toEqual([lane.id]));
    const second = stopMission('mission-stop-race');
    release();

    await expect(first).resolves.toMatchObject({
      packets: [expect.objectContaining({ status: 'stopped' })],
    });
    await expect(second).resolves.toMatchObject({
      packets: [expect.objectContaining({
        status: 'stop-failed',
        note: expect.stringContaining('another lifecycle action'),
      })],
    });
    expect(stopMock.calls).toEqual([lane.id]);
  });

  it('releases only its own mission admission hold when a packet stop throws', async () => {
    stopMock.calls.length = 0;
    stopMock.failures.clear();
    stopMock.gate = null;
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-stop-mission-throw-'));
    const lane = createLane({
      repoPath,
      branch: 'inline/stop-throw',
      runtime: 'codex',
      packetId: 'stop-throw',
    });
    setLaneStatus(lane.id, 'running', 'system', 'test_running');
    stopMock.throws.add(lane.id);
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-stop-throw',
      repoPath,
      packets: [packetFixture(repoPath, 'stop-throw', {
        status: 'running',
        lane: laneBinding(repoPath, lane.id),
      })],
    });

    await expect(stopMission('mission-stop-throw')).rejects.toThrow('fixture stop command failure');
    expect(readOrchestratorControlPlaneState()).toMatchObject({
      missionId: 'mission-stop-throw',
      lifecycleHold: null,
      packets: [{ id: 'stop-throw', status: 'running' }],
    });
  });
});
