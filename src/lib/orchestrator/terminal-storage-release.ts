import 'server-only';

import { getSqlite } from '@/lib/db';
import { getLaneEvents } from '@/lib/lane/registry';
import { releaseReservedStorageForTerminalOwner } from '@/lib/workspace/storage-admission-terminal-release';

function storageOwnerGenerationForLane(laneId: string): number | undefined {
  const generation = getLaneEvents(laneId, 200).findLast((event) => (
    event.verb === 'update'
    && Number.isSafeInteger(event.payload.storageAdmissionOwnerGeneration)
    && Number(event.payload.storageAdmissionOwnerGeneration) > 0
  ))?.payload.storageAdmissionOwnerGeneration;
  return typeof generation === 'number' ? generation : undefined;
}

export function releaseTerminalPacketStorageReservations(input: {
  packetId?: string | null;
  laneId: string;
  ownerGeneration?: number;
}) {
  return releaseReservedStorageForTerminalOwner({
    sqlite: getSqlite(),
    ownerIds: [input.packetId ?? '', input.laneId],
    ownerGeneration: input.ownerGeneration ?? storageOwnerGenerationForLane(input.laneId),
    terminalLaneId: input.laneId,
    mutationIdPrefix: `packet-storage-terminal-release:${input.laneId}`,
  });
}
