import { withLockedState } from '@/lib/orchestrator/control-plane';
import {
  findMissionRegistryEntryByPacketId,
  withMissionRegistryState,
} from '@/lib/orchestrator/mission-registry';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

function applyOperatorHold(packet: OrchestratorPacket) {
  packet.operatorStopped = true;
  packet.queueState = 'held';
  packet.status = 'blocked';
  packet.blockedReason = 'operator_stopped';
  packet.lastEventAt = new Date().toISOString();
  packet.lastEventLabel = 'operator_stopped';
}

/** Persist the lane stop guard in whichever durable mission store owns it. */
export async function persistLanePacketHold(packetId: string): Promise<boolean> {
  let currentFound = false;
  await withLockedState((state) => {
    const packet = state.packets.find((candidate) => candidate.id === packetId);
    if (!packet) return;
    currentFound = true;
    applyOperatorHold(packet);
  });
  if (currentFound) return true;

  const entry = findMissionRegistryEntryByPacketId(packetId, { includeArchived: true });
  if (!entry) return false;
  const { result } = await withMissionRegistryState(entry.id, (state) => {
    const packet = state.packets.find((candidate) => candidate.id === packetId);
    if (!packet) return { state, result: false };
    applyOperatorHold(packet);
    return { state, result: true };
  });
  return result;
}
