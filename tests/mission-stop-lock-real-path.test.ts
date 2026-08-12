import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-mission-stop-lock-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { recordMission } = await import('@/lib/db/missions-store');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { stopMission } = await import('@/lib/orchestrator/mission-stop');
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

describe('mission stop control-plane locking', () => {
  it('stops an awaiting-orchestrator lane without reacquiring its own lock', async () => {
    const packetId = 'pkt-stop-huddle';
    const lane = createLane({
      repoPath: join(dataDir, 'repo'),
      branch: 'inline/stop-huddle',
      runtime: 'codex',
      packetId,
    });
    const packet = {
      id: packetId,
      referenceLabel: 'inline-1',
      title: 'stop huddle worker',
      summary: 'stop a worker waiting for orchestrator direction',
      workspaceTargetPath: join(dataDir, 'repo'),
      branchTarget: 'inline/stop-huddle',
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'queued',
      releaseState: 'pending',
      status: 'blocked',
      blockedReason: 'huddle_ready',
      review: null,
      lane: {
        tileId: 'mcp-dispatch',
        tabId: 'mcp-dispatch',
        repoPath: join(dataDir, 'repo'),
        worktreePath: join(dataDir, 'repo'),
        runtime: 'codex',
        sessionKey: null,
        laneId: lane.id,
        lastHeartbeatAt: null,
        lastEventAt: null,
        lastEventLabel: 'huddle_ready',
      },
    } as OrchestratorPacket;
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-stop-huddle',
      repoPath: join(dataDir, 'repo'),
      packets: [packet],
    });

    const result = await Promise.race([
      stopMission('mission-stop-huddle'),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('mission stop deadlocked while stopping its own lane')),
        2_000,
      )),
    ]);

    expect(result.packets).toEqual([expect.objectContaining({
      packetId,
      status: 'stopped',
      laneId: lane.id,
    })]);
    const persisted = readOrchestratorControlPlaneState().packets[0];
    expect(persisted?.operatorStopped).toBe(true);
    expect(persisted?.queueState).toBe('held');
    expect(persisted?.blockedReason).toBe('operator_stopped');
  });

  it('stops a non-current mission without re-entering its registry lock', async () => {
    const packetId = 'pkt-stop-non-current';
    const missionId = 'mission-stop-non-current';
    const repoPath = join(dataDir, 'repo-non-current');
    const lane = createLane({
      repoPath,
      branch: 'inline/stop-non-current',
      runtime: 'codex',
      packetId,
    });
    setLaneStatus(lane.id, 'running', 'system', 'test_running');
    const packet = {
      id: packetId,
      referenceLabel: 'inline-1',
      title: 'stop a non-current worker',
      summary: 'registry mutation must not lock itself',
      workspaceTargetPath: repoPath,
      branchTarget: lane.branch,
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'queued',
      releaseState: 'pending',
      status: 'running',
      blockedReason: null,
      review: null,
      lane: {
        tileId: lane.id,
        tabId: lane.id,
        repoPath,
        worktreePath: null,
        runtime: 'codex',
        sessionKey: null,
        laneId: lane.id,
        lastHeartbeatAt: null,
        lastEventAt: null,
        lastEventLabel: null,
      },
    } as OrchestratorPacket;
    const missionState = {
      ...createEmptyOrchestratorMissionState(),
      missionId,
      repoPath,
      packets: [packet],
    };
    recordMission({
      id: missionId,
      repoPath,
      runtime: 'codex',
      prompt: 'stop non-current',
      summary: 'stop non-current',
      constraints: '',
      packetMeta: [{ id: packetId, title: packet.title, referenceLabel: packet.referenceLabel }],
      missionState,
      totalWaves: 1,
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'different-current-mission',
    });

    const result = await Promise.race([
      stopMission(missionId),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('non-current mission stop deadlocked on its registry lock')),
        2_000,
      )),
    ]);

    expect(result.packets).toEqual([expect.objectContaining({
      packetId,
      status: 'stopped',
      laneId: lane.id,
    })]);
  });
});
