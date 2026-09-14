import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { getSqlite } from '@/lib/db';
import { managedPacketWorktreeId } from '@/lib/worktree/root-layout';
import { recordLaneEvent } from './events';
import {
  laneStorageOwnerGeneration,
  releaseReservedStorageForTerminalOwner,
} from '@/lib/workspace/storage-admission-terminal-release';
import { LANE_TERMINAL_STATUSES } from './terminal-states';
import type { Lane, LaneStatus } from './types';

export interface PacketWorktreeProvisionStorageRelease {
  decision: 'released' | 'deferred';
  ownerGeneration: number | null;
  releasedReservations: number;
  releasedBytes: number;
  retainedOwnerIds: string[];
  reason: 'released' | 'already_settled' | 'packet_association_unprovable'
    | 'materialized_worktree_present' | 'release_scope_unprovable'
    | 'storage_release_failed';
  evidence?: string;
  error?: string;
}

interface ReservationTargetRow {
  target_path: string;
}

function packetCheckoutAbsenceFromReservedTargets(
  packetId: string,
  ownerGeneration: number | undefined,
): { state: 'absent' | 'present' | 'unknown'; evidence: string } {
  const sqlite = getSqlite();
  const rows = ownerGeneration === undefined
    ? sqlite.prepare(`
        SELECT DISTINCT target_path FROM storage_admission_reservations
        WHERE owner_id = ? AND state = 'reserved'
      `).all(packetId) as ReservationTargetRow[]
    : sqlite.prepare(`
        SELECT DISTINCT target_path FROM storage_admission_reservations
        WHERE owner_id = ? AND state = 'reserved' AND owner_generation <= ?
      `).all(packetId, ownerGeneration) as ReservationTargetRow[];
  if (rows.length === 0) {
    return { state: 'absent', evidence: 'No releasable reserved storage row remains.' };
  }
  if (ownerGeneration === undefined) {
    return {
      state: 'unknown',
      evidence: 'Reserved storage exists without an exact lane owner-generation receipt.',
    };
  }
  const worktreeId = managedPacketWorktreeId(packetId);
  if (!worktreeId) {
    return { state: 'unknown', evidence: 'The packet owner has no managed checkout id.' };
  }
  const matchesPacketCheckout = (name: string) => (
    name === worktreeId || name.startsWith(`${worktreeId}-`)
  );

  for (const row of rows) {
    const targetPath = path.resolve(row.target_path);
    try {
      const target = lstatSync(targetPath);
      if (matchesPacketCheckout(path.basename(targetPath))) {
        return { state: 'present', evidence: 'The admitted packet checkout still exists.' };
      }
      if (target.isSymbolicLink() || !target.isDirectory()) {
        return {
          state: 'unknown',
          evidence: 'The admitted checkout root is not a stable directory.',
        };
      }
      if (readdirSync(targetPath).some(matchesPacketCheckout)) {
        return { state: 'present', evidence: 'A packet-named checkout exists under the admitted root.' };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      return {
        state: 'unknown',
        evidence: `The admitted checkout root could not be inspected (${code ?? 'unknown error'}).`,
      };
    }
  }
  return { state: 'absent', evidence: 'No packet-named checkout exists under the admitted root.' };
}

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
 * Settle the reservation while a failed packet checkout is still associated
 * with its lane. The launch event supplies the exact reservation generation;
 * without that proof the reservation stays reserved and the caller records the
 * deferred decision on the provisioning-failure event.
 */
export function releasePacketStorageAfterWorktreeProvisionFailure(
  lane: Pick<Lane, 'id' | 'packetId' | 'repoPath' | 'worktreePath'>,
  expectedPacketId: string,
): PacketWorktreeProvisionStorageRelease {
  const packetId = expectedPacketId.trim();
  const ownerGeneration = packetId
    ? laneStorageOwnerGeneration(getSqlite(), lane.id, packetId)
    : undefined;
  const deferred = (
    reason: Extract<PacketWorktreeProvisionStorageRelease['reason'],
      'packet_association_unprovable' | 'materialized_worktree_present'>,
  ): PacketWorktreeProvisionStorageRelease => ({
    decision: 'deferred',
    ownerGeneration: ownerGeneration ?? null,
    releasedReservations: 0,
    releasedBytes: 0,
    retainedOwnerIds: packetId ? [packetId] : [],
    reason,
  });

  if (!packetId || lane.packetId?.trim() !== packetId) {
    return deferred('packet_association_unprovable');
  }
  if (laneOwnsWorktree(lane) && !worktreeIsConfirmedAbsent(lane.worktreePath)) {
    return {
      ...deferred('materialized_worktree_present'),
      evidence: 'The lane-bound checkout still exists.',
    };
  }
  const checkout = packetCheckoutAbsenceFromReservedTargets(packetId, ownerGeneration);
  if (checkout.state !== 'absent') {
    return {
      ...deferred(checkout.state === 'present'
        ? 'materialized_worktree_present'
        : 'packet_association_unprovable'),
      reason: checkout.state === 'present'
        ? 'materialized_worktree_present'
        : 'release_scope_unprovable',
      evidence: checkout.evidence,
    };
  }

  const settlement = releaseReservedStorageForTerminalOwner({
    sqlite: getSqlite(),
    ownerIds: [packetId],
    ownerGeneration,
    terminalLaneId: lane.id,
    mutationIdPrefix: `packet-storage-provision-failure-release:${lane.id}`,
    unprovableScopePolicy: 'retain',
  });
  if (settlement.retainedUnprovableOwnerIds.length > 0) {
    return {
      decision: 'deferred',
      ownerGeneration: ownerGeneration ?? null,
      releasedReservations: settlement.released,
      releasedBytes: settlement.releasedBytes,
      retainedOwnerIds: settlement.retainedUnprovableOwnerIds,
      reason: 'release_scope_unprovable',
    };
  }
  return {
    decision: 'released',
    ownerGeneration: ownerGeneration ?? null,
    releasedReservations: settlement.released,
    releasedBytes: settlement.releasedBytes,
    retainedOwnerIds: [],
    reason: settlement.released > 0 ? 'released' : 'already_settled',
    evidence: checkout.evidence,
  };
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
