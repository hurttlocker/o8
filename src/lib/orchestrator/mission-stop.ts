import 'server-only';

import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { findLaneByPacket } from '@/lib/lane/registry';
import { isTerminalLaneStatus } from '@/lib/lane/types';
import { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { listActiveMissionRegistryEntries, withMissionRegistryState } from '@/lib/orchestrator/mission-registry';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

export type StopMissionPacketStatus = 'stopped' | 'already-terminal' | 'stop-failed';

export interface StopMissionPacketResult {
  packetId: string;
  status: StopMissionPacketStatus;
  laneId: string | null;
  note: string;
}

export interface StopMissionResult {
  missionId: string;
  event: {
    type: 'mission_stop';
    recordedAt: string;
  };
  packets: StopMissionPacketResult[];
}

export interface GlobalDispatchHaltResult {
  halted: boolean;
  stoppedMissions: StopMissionResult[];
}

function isPacketTerminal(packet: OrchestratorPacket): boolean {
  return Boolean(packet.archivedAt)
    || packet.releaseState === 'released'
    || packet.status === 'released'
    || packet.status === 'archived'
    || packet.status === 'failed'
    || packet.status === 'awaiting_review';
}

function markStoppedPacket(packet: OrchestratorPacket, stoppedAt: string): OrchestratorPacket {
  return {
    ...packet,
    operatorStopped: true,
    queueState: 'held',
    status: 'blocked',
    blockedReason: 'operator_stopped',
    lastEventAt: stoppedAt,
    lastEventLabel: 'operator_stopped',
  };
}

async function stopPacketViaLaneCommand(packet: OrchestratorPacket): Promise<StopMissionPacketResult> {
  if (isPacketTerminal(packet)) {
    return {
      packetId: packet.id,
      status: 'already-terminal',
      laneId: packet.lane?.laneId ?? null,
      note: `Packet is already terminal (${packet.status}).`,
    };
  }

  const lane = packet.lane?.laneId ? null : findLaneByPacket(packet.id);
  const laneId = packet.lane?.laneId ?? lane?.id ?? null;
  const laneStatus = lane?.status ?? null;
  if (laneStatus && isTerminalLaneStatus(laneStatus)) {
    return {
      packetId: packet.id,
      status: 'already-terminal',
      laneId,
      note: `Lane is already terminal (${laneStatus}).`,
    };
  }
  if (!laneId) {
    if (packet.queueState === 'queued' && !packet.lane) {
      return {
        packetId: packet.id,
        status: 'stopped',
        laneId: null,
        note: 'Queued packet held before any lane launched.',
      };
    }
    return {
      packetId: packet.id,
      status: 'stop-failed',
      laneId: null,
      note: 'No lane is bound to this packet.',
    };
  }

  const result = await dispatchLaneCommand({ verb: 'stop', laneId, actor: 'user' });
  return {
    packetId: packet.id,
    status: result.ok ? 'stopped' : 'stop-failed',
    laneId,
    note: result.note,
  };
}

function applyStopResults(
  state: OrchestratorMissionState,
  results: StopMissionPacketResult[],
  stoppedAt: string,
): OrchestratorMissionState {
  const stoppedIds = new Set(results.filter((result) => result.status === 'stopped').map((result) => result.packetId));
  return normalizeOrchestratorMissionState({
    ...state,
    packets: state.packets.map((packet) => (
      stoppedIds.has(packet.id) ? markStoppedPacket(packet, stoppedAt) : packet
    )),
    updatedAt: stoppedAt,
  });
}

async function stopMissionState(state: OrchestratorMissionState): Promise<{ state: OrchestratorMissionState; result: StopMissionResult }> {
  const missionId = state.missionId?.trim();
  if (!missionId) throw new Error('missionId is required.');
  const stoppedAt = new Date().toISOString();
  const packets: StopMissionPacketResult[] = [];
  for (const packet of state.packets) {
    packets.push(await stopPacketViaLaneCommand(packet));
  }
  return {
    state: applyStopResults(state, packets, stoppedAt),
    result: {
      missionId,
      event: {
        type: 'mission_stop',
        recordedAt: stoppedAt,
      },
      packets,
    },
  };
}

export async function stopMission(missionId: string): Promise<StopMissionResult> {
  const normalizedId = missionId.trim();
  if (!normalizedId) throw new Error('missionId is required.');

  const current = readOrchestratorControlPlaneState();
  if ((current.missionId ?? '').trim() === normalizedId) {
    const { state, result } = await stopMissionState(current);
    writeOrchestratorControlPlaneState(state);
    return result;
  }

  const { result } = await withMissionRegistryState(normalizedId, stopMissionState);
  return result;
}

export async function stopAllActiveMissions(): Promise<GlobalDispatchHaltResult> {
  const stoppedMissions: StopMissionResult[] = [];
  const current = readOrchestratorControlPlaneState();
  if ((current.missionId ?? '').trim()) {
    stoppedMissions.push(await stopMission(current.missionId ?? ''));
  }
  for (const entry of listActiveMissionRegistryEntries(current.missionId)) {
    stoppedMissions.push(await stopMission(entry.id));
  }
  return {
    halted: true,
    stoppedMissions,
  };
}
