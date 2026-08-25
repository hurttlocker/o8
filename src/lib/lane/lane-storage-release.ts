import { lstatSync } from 'node:fs';

import { getSqlite } from '@/lib/db';
import { recordLaneEvent } from './events';
import {
  laneStorageOwnerGeneration,
  releaseReservedStorageForTerminalOwner,
} from '@/lib/workspace/storage-admission-terminal-release';
import { LANE_TERMINAL_STATUSES } from './terminal-states';
import type { Lane, LaneStatus } from './types';

export function worktreeIsConfirmedAbsent(worktreePath: string | null): boolean {
  const normalized = worktreePath?.trim();
  if (!normalized) return true;
  try {
    lstatSync(normalized);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

/** Main-checkout sessions have no lane-owned directory to retire. */
export function laneOwnsWorktree(
  lane: Pick<Lane, 'repoPath' | 'worktreePath'>,
): boolean {
  const worktreePath = lane.worktreePath?.trim().replace(/\/+$/, '');
  const repoPath = lane.repoPath.trim().replace(/\/+$/, '');
  return Boolean(worktreePath && worktreePath !== repoPath);
}

function captureLaneStorageOwnerGeneration(
  lane: Pick<Lane, 'id' | 'packetId'>,
): number | undefined {
  const packetId = lane.packetId?.trim();
  if (!packetId) return undefined;
  return laneStorageOwnerGeneration(getSqlite(), lane.id, packetId);
}

export function captureLaneStorageCleanup(lane: Lane): Lane & {
  storageAdmissionOwnerGeneration?: number;
} {
  return { ...lane, storageAdmissionOwnerGeneration: captureLaneStorageOwnerGeneration(lane) };
}

/**
 * A packet storage reservation accounts for its checkout, not merely the lane
 * row that currently names the packet. Association loss or a `failed` status is
 * therefore not release evidence while that checkout still exists.
 *
 * This chokepoint handles only the complementary case: the lane is losing its
 * packet association (or becoming terminal) after the checkout is already
 * confirmed absent. Ordinary terminal cleanup carries the exact owner
 * generation to `cleanupLaneWorktree`, which releases only after removal.
 *
 * This function MUST be called from inside the caller's open transaction, and
 * before the association-losing write. That keeps the no-checkout case atomic:
 *
 *  - `releaseReservedStorageForTerminalOwner` joins the open transaction rather
 *    than opening its own, so release and association loss commit together.
 *  - Errors PROPAGATE when the write destroys association evidence. A status-
 *    only terminal transition may retain an unprovable reservation because the
 *    lane still names the packet and a later cleanup can retry with that proof.
 *    Storage mutation failures still roll every lane write back.
 */
export function settleLaneStorageOnAssociationLoss(
  lane: Pick<Lane, 'id' | 'packetId' | 'repoPath' | 'worktreePath'>,
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
  if (laneOwnsWorktree(lane) && !worktreeIsConfirmedAbsent(lane.worktreePath)) return;

  const sqlite = getSqlite();
  // Read inside the transaction, before the lane's events are appended to or
  // deleted, so the generation still reflects the launch that reserved.
  const ownerGeneration = laneStorageOwnerGeneration(sqlite, lane.id, packetId);
  const settlement = releaseReservedStorageForTerminalOwner({
    sqlite,
    ownerIds: [packetId, lane.id],
    ownerGeneration,
    terminalLaneId: lane.id,
    mutationIdPrefix: `packet-storage-terminal-release:${lane.id}`,
    unprovableScopePolicy: associationLost ? 'throw' : 'retain',
  });
  if (settlement.retainedUnprovableOwnerIds.length > 0) {
    recordLaneEvent(lane.id, 'storage_release_deferred', 'system', {
      packetId,
      ownerGeneration: ownerGeneration ?? null,
      retainedOwnerIds: settlement.retainedUnprovableOwnerIds,
      reason: 'terminal_status_preserved_association_evidence',
    });
  }
}
