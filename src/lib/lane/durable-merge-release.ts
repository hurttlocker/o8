import type { Lane } from '@/lib/lane/types';
import { markPacketReleased } from '@/lib/orchestrator/packet-release-truth';
import { packetReleaseGeneration, packetReleaseIdentityIsCurrent } from '@/lib/orchestrator/release-ownership';

/** Capture ownership before git I/O; commit release before retirement can reconcile the lane. */
export async function prepareDurableMergeRelease(lane: Lane) {
  const [{ withLockedState }, { findMissionRegistryEntryByPacketId, persistReleasedPacketToMission }] = await Promise.all([
    import('@/lib/orchestrator/control-plane'), import('@/lib/orchestrator/mission-registry'),
  ]);
  const owner = lane.packetId
    ? findMissionRegistryEntryByPacketId(lane.packetId, { includeArchived: true }) : null;
  const owned = owner?.mission.packets.find((packet) => packet.id === lane.packetId);
  if (!owned) return async (_mergeSha: string, _reviewedHeadSha: string) => {};
  const generation = packetReleaseGeneration(owned, lane.id);
  return async (mergeSha: string, reviewedHeadSha: string) => {
    await withLockedState(async (fresh) => {
      const current = fresh.missionId === owner!.id
        ? fresh.packets.find((packet) => packet.id === owned.id) : null;
      const packet = current ?? structuredClone(owned);
      if (!packetReleaseIdentityIsCurrent(packet, lane.id, generation, true)) {
        throw new Error('Durable packet ownership changed before inner merge retirement.');
      }
      markPacketReleased(packet, { source: 'approve_and_merge', mergeCommit: mergeSha,
        headSha: reviewedHeadSha, evidenceKind: 'merge_command' });
      packet.lastEventAt = packet.releaseStatePayload!.releasedAt!;
      packet.lastEventLabel = 'merged';
      if (!(await persistReleasedPacketToMission(packet, lane.id, generation))) {
        throw new Error('Durable packet ownership changed before inner merge retirement.');
      }
    });
  };
}
