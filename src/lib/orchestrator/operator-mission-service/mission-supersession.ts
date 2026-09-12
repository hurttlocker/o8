import { findLaneByPacket } from '@/lib/lane/registry';
import {
  listActiveMissionRegistryEntries,
  withMissionRegistryState,
} from '@/lib/orchestrator/mission-registry';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

const SUPERSEDED_PACKET_REASON = 'superseded_by_newer_mission';

function packetBelongsToThread(packet: OrchestratorPacket, threadId: string): boolean {
  return packet.orchestratorThreadId?.trim() === threadId;
}

function packetIsInFlight(packet: OrchestratorPacket): boolean {
  return packet.status === 'launching'
    || packet.status === 'running'
    || packet.status === 'awaiting_review'
    || findLaneByPacket(packet.id) !== null;
}

export function cancelSupersededMissionPackets(
  state: OrchestratorMissionState,
  input: { threadId: string; successorMissionId: string; cancelledAt: string },
): boolean {
  const threadId = input.threadId.trim();
  if (!threadId || state.missionId === input.successorMissionId) return false;

  let changed = false;
  for (const packet of state.packets) {
    if (!packetBelongsToThread(packet, threadId)) continue;
    if (packet.archivedAt || packet.releaseState === 'released' || packet.status === 'failed') continue;
    if (packet.operatorStopped) continue;

    // Supersession policy: an in-flight packet keeps running and follows the
    // normal review path. Cancel only packets that have not launched, so the
    // successor cannot later open a second lane for the same thread's work.
    if (packetIsInFlight(packet)) continue;

    packet.operatorStopped = true;
    packet.queueState = 'held';
    packet.status = 'blocked';
    packet.blockedReason = SUPERSEDED_PACKET_REASON;
    packet.lastEventAt = input.cancelledAt;
    packet.lastEventLabel = SUPERSEDED_PACKET_REASON;
    packet.releaseStatePayload = {
      source: `mission_superseded:${input.successorMissionId}`,
    };
    changed = true;
  }
  return changed;
}

export async function cancelSupersededRegistryMissions(input: {
  threadId: string;
  successorMissionId: string;
  cancelledAt: string;
}): Promise<void> {
  for (const entry of listActiveMissionRegistryEntries(input.successorMissionId)) {
    if (!entry.mission.packets.some((packet) => packetBelongsToThread(packet, input.threadId))) {
      continue;
    }
    await withMissionRegistryState(entry.id, (state) => {
      cancelSupersededMissionPackets(state, input);
      return { state, result: undefined };
    });
  }
}
