import 'server-only';

import { getSqlite } from '@/lib/db';
import {
  laneStorageOwnerGeneration,
  releaseReservedStorageForTerminalOwner,
} from '@/lib/workspace/storage-admission-terminal-release';

/**
 * Delegates to `laneStorageOwnerGeneration` rather than re-deriving the value.
 * The two paths decide the same release scope, so a second implementation is a
 * second answer: this one read only the most recent 200 events and took the
 * newest by timestamp, which disagreed with the chokepoint on both a long event
 * history and a same-millisecond generation tie.
 */
export function storageOwnerGenerationForLane(laneId: string, ownerId: string): number | undefined {
  return laneStorageOwnerGeneration(getSqlite(), laneId, ownerId);
}

export function releaseTerminalPacketStorageReservations(input: {
  packetId?: string | null;
  laneId: string;
  ownerGeneration?: number;
}) {
  return releaseReservedStorageForTerminalOwner({
    sqlite: getSqlite(),
    ownerIds: [input.packetId ?? '', input.laneId],
    ownerGeneration: input.ownerGeneration
      ?? storageOwnerGenerationForLane(input.laneId, input.packetId?.trim() || input.laneId),
    terminalLaneId: input.laneId,
    mutationIdPrefix: `packet-storage-terminal-release:${input.laneId}`,
  });
}
