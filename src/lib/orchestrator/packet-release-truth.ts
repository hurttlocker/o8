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
  source:
    | 'approve_and_merge'
    | 'headless_released'
    | 'heal_bot_auto_release'
    | 'merged_by_ancestry_reconcile'
    | 'read_only_completed';
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
  'releaseState' | 'releaseStatePayload' | 'status' | 'queueState' | 'blockedReason' | 'recovery'
>;

/**
 * True when the packet's release carries a recorded origin. A release with no
 * payload was fabricated by derivation, not proved by a merge path.
 */
export function hasCanonicalReleaseEvidence(
  packet: Pick<OrchestratorPacket, 'releaseStatePayload'>,
): boolean {
  const payload = packet.releaseStatePayload;
  const source = payload?.source?.trim() ?? '';
  const mergeCommit = payload?.mergeCommit?.trim() ?? '';
  const evidenceKind = payload?.evidenceKind?.trim() ?? '';

  if (source === 'read_only_completed') {
    return evidenceKind === '' || evidenceKind === 'read_only_no_merge_required';
  }
  if (source === 'headless_released') {
    return evidenceKind === 'headless_loop';
  }
  if (
    source === 'approve_and_merge'
    || source === 'heal_bot_auto_release'
    || source === 'merged_by_ancestry_reconcile'
  ) {
    return mergeCommit.length > 0;
  }
  return false;
}

export function buildReleaseStatePayload(
  _existing: OrchestratorReleaseStatePayload | null | undefined,
  evidence: PacketReleaseEvidence,
): OrchestratorReleaseStatePayload {
  return {
    // A new proof replaces the old receipt. Carrying fields forward can attach
    // a stale merge SHA to a later headless/read-only release and make two
    // different events look like one coherent proof.
    mergeCommit: evidence.mergeCommit ?? null,
    headSha: evidence.headSha ?? null,
    evidenceKind: evidence.evidenceKind ?? null,
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
  const releaseStatePayload = buildReleaseStatePayload(packet.releaseStatePayload, evidence);
  if (!hasCanonicalReleaseEvidence({ releaseStatePayload })) {
    throw new Error(`Release evidence from ${evidence.source} is incomplete.`);
  }
  packet.status = 'released';
  packet.queueState = 'held';
  packet.releaseState = 'released';
  packet.releaseStatePayload = releaseStatePayload;
  packet.blockedReason = null;
  packet.recovery = null;
}

export function clearUnprovenReleaseClaim(packet: ReleasablePacket): boolean {
  const claimsRelease = packet.releaseState === 'released' || packet.status === 'released';
  if (!claimsRelease) return false;
  if (packet.releaseState === 'released' && hasCanonicalReleaseEvidence(packet)) return false;
  packet.releaseState = 'pending';
  packet.releaseStatePayload = null;
  if (packet.status === 'released') packet.status = 'awaiting_review';
  if (packet.queueState === 'held') packet.queueState = 'queued';
  packet.blockedReason = 'Release evidence is missing; review recovery is required.';
  return true;
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
  if (packet.releaseState === 'released' && hasCanonicalReleaseEvidence(packet)) {
    packet.status = 'released';
    packet.blockedReason = null;
    packet.recovery = null;
    return;
  }
  clearUnprovenReleaseClaim(packet);
  packet.status = 'awaiting_review';
  packet.blockedReason = 'Lane completed without canonical release evidence.';
}
