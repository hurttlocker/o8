import { getSqlite } from '@/lib/db';
import {
  laneStorageOwnerGeneration,
  releaseReservedStorageForTerminalOwner,
} from '@/lib/workspace/storage-admission-terminal-release';
import { LANE_TERMINAL_STATUSES } from './terminal-states';
import type { Lane, LaneStatus } from './types';

/**
 * A packet-owned storage reservation is only reachable while the lane row still
 * names its packet — the reservation's owner id IS the packet id. So the moment
 * a lane write clears or reassigns `lanes.packet_id`, or drops the lane to a
 * terminal status, the reservation must already be settled or it is orphaned:
 * nothing left in the database points at it, and its bytes are subtracted from
 * dispatch headroom forever.
 *
 * Every production write of that shape funnels through `updateLane`/`deleteLane`,
 * so settlement is derived there rather than at each caller — a helper callers
 * must remember to invoke is what leaked the reservations in the first place.
 *
 * This function MUST be called from inside the caller's open transaction, and
 * before the association-losing write. Two properties follow, and both are the
 * point of the design:
 *
 *  - `releaseReservedStorageForTerminalOwner` joins the open transaction rather
 *    than opening its own, so the release and the association loss commit as one
 *    unit. There is no window in which the association is gone but the
 *    reservation is still `reserved`.
 *  - Errors PROPAGATE. A settlement failure must roll the lane write back and
 *    leave the reservation recoverable, not commit an unreachable row. Callers
 *    must not wrap this in a catch.
 *
 * Running before the write also keeps live-sibling protection honest: the helper
 * excludes `terminalLaneId` itself and retains any generation a surviving lane
 * still owns while releasing generations that only the retiring lane can own.
 */
export function settleLaneStorageOnAssociationLoss(
  lane: Pick<Lane, 'id' | 'packetId'>,
  changes: { packetId?: unknown; status?: unknown },
): void {
  const packetId = lane.packetId?.trim();
  if (!packetId) return;
  // `changes` carries only fields that genuinely change (updateLane filters
  // no-op writes), so a present `packetId` key always means association loss.
  const associationLost = changes.packetId !== undefined;
  const wentTerminal = typeof changes.status === 'string'
    && LANE_TERMINAL_STATUSES.has(changes.status as LaneStatus);
  if (!associationLost && !wentTerminal) return;

  const sqlite = getSqlite();
  // Read inside the transaction, before the lane's events are appended to or
  // deleted, so the generation still reflects the launch that reserved.
  const ownerGeneration = laneStorageOwnerGeneration(sqlite, lane.id, packetId);
  releaseReservedStorageForTerminalOwner({
    sqlite,
    ownerIds: [packetId, lane.id],
    ownerGeneration,
    terminalLaneId: lane.id,
    mutationIdPrefix: `packet-storage-terminal-release:${lane.id}`,
  });
}
