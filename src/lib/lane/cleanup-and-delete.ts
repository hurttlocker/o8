import 'server-only';

import { captureLaneStorageCleanup, worktreeIsConfirmedAbsent } from './lane-storage-release';
import { deleteLane, getLane } from './registry';
import type { Lane } from './types';
import { cleanupLaneWorktree } from './worktree-cleanup';

/**
 * Destructive lane deletion must not erase the checkout path or admission
 * generation before cleanup settles them. The low-level deleteLane guard makes
 * this the only production route for a lane whose checkout still exists.
 */
export async function cleanupAndDeleteLane(laneId: string): Promise<Lane | null> {
  const lane = getLane(laneId);
  if (!lane) return null;

  if (!worktreeIsConfirmedAbsent(lane.worktreePath)) {
    const removed = await cleanupLaneWorktree(captureLaneStorageCleanup(lane), {
      terminal: true,
      force: true,
    });
    if (!removed && !worktreeIsConfirmedAbsent(lane.worktreePath)) {
      throw new Error(`Checkout removal was not confirmed for lane ${laneId}; lane metadata was preserved.`);
    }
  }

  return deleteLane(laneId);
}
