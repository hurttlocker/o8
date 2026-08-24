import { withMissionHandoffBarrier } from '@/lib/orchestrator/lifecycle-mutation-lock';
import {
  findMissionRegistryEntryByPacketId,
  withMissionRegistryState,
} from '@/lib/orchestrator/mission-registry';
import { clearUnprovenReleaseClaim } from '@/lib/orchestrator/packet-release-truth';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

/** Repair the current or registry-backed packet that owns a recovered review. */
export async function repairUnprovenPacketRelease(
  packetId: string,
  expectedLaneId?: string | null,
): Promise<boolean> {
  const normalizedPacketId = packetId.trim();
  if (!normalizedPacketId) return false;
  const matchesLane = (packet: OrchestratorPacket) => (
    !expectedLaneId || !packet.lane?.laneId || packet.lane.laneId === expectedLaneId
  );
  const repair = (packet: OrchestratorPacket): boolean => {
    if (!matchesLane(packet) || !clearUnprovenReleaseClaim(packet)) return false;
    packet.status = 'awaiting_review';
    packet.queueState = 'queued';
    packet.blockedReason = null;
    return true;
  };

  return withMissionHandoffBarrier(async () => {
    let currentMissionId = '';
    const { result: current } = await withLockedState((state) => {
      currentMissionId = state.missionId?.trim() ?? '';
      const packet = state.packets.find((candidate) => candidate.id === normalizedPacketId);
      return packet
        ? { found: true, repaired: repair(packet) }
        : { found: false, repaired: false };
    });
    if (current.found) return current.repaired;

    const registry = findMissionRegistryEntryByPacketId(normalizedPacketId, {
      includeArchived: true,
      excludeMissionId: currentMissionId || undefined,
    });
    if (!registry) return false;
    const { result } = await withMissionRegistryState(registry.id, (state) => {
      const packet = state.packets.find((candidate) => candidate.id === normalizedPacketId);
      return { state, result: packet ? repair(packet) : false };
    });
    return result;
  });
}
