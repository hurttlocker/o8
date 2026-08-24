/**
 * Release truth (#1844 / #1856 recurrence).
 *
 * `releaseState: 'released'` is the strongest claim the control plane makes: it
 * hides the packet from dispatch, unblocks its dependents, and stops every
 * recovery sweep from touching the lane. It is supposed to mean "this work is
 * on the base branch."
 *
 * It was also being *derived*. `reconcileOrchestratorMissionState()` mapped a
 * lane status of `completed` straight onto the durable flag, with no
 * `releaseStatePayload` and no ancestry proof — and lane `completed` is written
 * by paths that never merged anything (an operator `complete` command, and the
 * `worktree_missing_reconciled` / `branch_merged_reconciled` reconciler). Once
 * written the flag latched, because every later reconcile returns early on
 * `releaseState === 'released'`. A packet could therefore read as released with
 * its commits nowhere on `main`.
 *
 * Every deliberate release writer already records where the release came from.
 * This module makes that the rule: release truth is written here, with
 * evidence, or it is not written.
 */

import type { OrchestratorPacket, OrchestratorReleaseStatePayload } from '@/lib/orchestrator/types';

export interface PacketReleaseEvidence {
  /** Which path proved the release — always recorded, never inferred. */
  source: string;
  /** The base-branch commit the work reached, when the path resolved one. */
  mergeCommit?: string | null;
  /** The packet HEAD the proof was taken against. Lets later drift be detected. */
  headSha?: string | null;
  /** How the merge was proven: 'ancestor' | 'patch-id' | path-specific. */
  evidenceKind?: string | null;
  releasedAt?: string;
}

type ReleasablePacket = Pick<
  OrchestratorPacket,
  'releaseState' | 'releaseStatePayload' | 'status' | 'queueState' | 'blockedReason'
>;

/**
 * True when the packet's release carries a recorded origin. A release with no
 * payload was fabricated by derivation, not proved by a merge path.
 */
export function hasCanonicalReleaseEvidence(
  packet: Pick<OrchestratorPacket, 'releaseStatePayload'>,
): boolean {
  const source = packet.releaseStatePayload?.source;
  return typeof source === 'string' && source.trim().length > 0;
}

export function buildReleaseStatePayload(
  existing: OrchestratorReleaseStatePayload | null | undefined,
  evidence: PacketReleaseEvidence,
): OrchestratorReleaseStatePayload {
  return {
    ...(existing ?? {}),
    mergeCommit: evidence.mergeCommit ?? existing?.mergeCommit ?? null,
    headSha: evidence.headSha ?? existing?.headSha ?? null,
    evidenceKind: evidence.evidenceKind ?? existing?.evidenceKind ?? null,
    releasedAt: evidence.releasedAt ?? new Date().toISOString(),
    source: evidence.source,
  };
}

/**
 * The only sanctioned writer of `releaseState = 'released'`. The flag and its
 * receipt land together, so a release can never exist without one.
 */
export function markPacketReleased(
  packet: ReleasablePacket,
  evidence: PacketReleaseEvidence,
): void {
  packet.status = 'released';
  packet.queueState = 'held';
  packet.releaseState = 'released';
  packet.releaseStatePayload = buildReleaseStatePayload(packet.releaseStatePayload, evidence);
  packet.blockedReason = null;
}

/**
 * Derivation's half of the rule: a lane reaching `completed` may present as
 * released, but it may not MINT release truth.
 *
 * Lane `completed` is written by paths that never touched the base branch — an
 * operator `complete` command, and the reconciler's `worktree_missing_reconciled`
 * / `branch_merged_reconciled` sweeps. Mapping that onto the durable flag
 * produced a release with no ancestry behind it, and the flag then latched,
 * because every later reconcile returns early on `releaseState === 'released'`.
 * The durable claim is left to the merge paths that carry evidence.
 */
export function applyLaneCompletedRelease(packet: ReleasablePacket): void {
  packet.status = 'released';
  if (hasCanonicalReleaseEvidence(packet)) packet.releaseState = 'released';
}
