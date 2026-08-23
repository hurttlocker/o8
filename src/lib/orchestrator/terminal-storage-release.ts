import 'server-only';

import { getSqlite } from '@/lib/db';
import { releaseReservedStorageForTerminalOwner } from '@/lib/workspace/storage-admission-terminal-release';

export function releaseTerminalPacketStorageReservations(input: {
  packetId?: string | null;
  laneId: string;
}) {
  return releaseReservedStorageForTerminalOwner({
    sqlite: getSqlite(),
    ownerIds: [input.packetId ?? '', input.laneId],
    terminalLaneId: input.laneId,
    mutationIdPrefix: `packet-storage-terminal-release:${input.laneId}`,
  });
}
