/**
 * Recorded merge dispatch after a blind second pass agrees (#1856).
 *
 * `markSecondPassAgreed()` and the merge `dispatch()` used to be two adjacent
 * statements with nothing between them written to the ledger. When the merge
 * did not happen — process ended, or the dispatch returned `ok:false` and the
 * result was only console-logged — the lane parked in `reviewing` forever with
 * a fully-authorizing approval and no `merge` event, no failure, no reason.
 *
 * Agreement and dispatch are now one recorded transition: an attempt event is
 * written BEFORE the dispatch (so a crash between the two leaves a trace that
 * reconciliation can act on) and a failure event plus a durable operator
 * blocker are written when the dispatch does not merge.
 */

import { getSqlite } from '@/lib/db';
import { recordLaneEvent } from './events';
import { surfaceReviewQueueBlocker } from './review-queue';
import type { Lane } from './types';

export type SecondPassMergeTrigger = 'second_pass_agreed' | 'stall_reconcile';

export interface SecondPassMergeDispatchResult {
  ok: boolean;
  note: string;
  /** Set when the merge routed to an operator approval card instead of merging. */
  approvalId: string | null;
}

/**
 * Has a merge already been attempted for this exact authorization? Keyed on the
 * approval id so reconciliation is idempotent: one recorded attempt per
 * authorizing approval, whether it succeeded or left a failure receipt.
 */
export function hasRecordedMergeDispatch(laneId: string, approvalId: string): boolean {
  try {
    const rows = getSqlite().prepare(`
      SELECT payload_json FROM lane_events
      WHERE lane_id = ? AND verb = 'merge_dispatch_attempted'
      ORDER BY rowid DESC
      LIMIT 50
    `).all(laneId) as { payload_json: string }[];
    return rows.some((row) => {
      try {
        return (JSON.parse(row.payload_json) as { approvalId?: unknown }).approvalId === approvalId;
      } catch {
        return false;
      }
    });
  } catch {
    // Unreadable ledger must not authorize a second dispatch.
    return true;
  }
}

export async function dispatchSecondPassMerge(input: {
  lane: Lane;
  approvalId: string;
  reviewedHeadSha: string;
  trigger: SecondPassMergeTrigger;
}): Promise<SecondPassMergeDispatchResult> {
  const { lane, approvalId, reviewedHeadSha, trigger } = input;

  recordLaneEvent(lane.id, 'merge_dispatch_attempted', 'system', {
    packetId: lane.packetId ?? null,
    approvalId,
    reviewedHeadSha,
    trigger,
  });

  let ok = false;
  let note = '';
  let routedApprovalId: string | null = null;
  try {
    const { dispatch } = await import('@/lib/lane/commands');
    const mergeResult = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
    ok = mergeResult.ok;
    note = mergeResult.note ?? '';
    routedApprovalId = mergeResult.approvalId ?? null;
  } catch (error) {
    ok = false;
    note = error instanceof Error ? error.message : String(error);
  }

  if (ok) {
    console.log(`[auto-review] Merge dispatched for lane ${lane.id} (${trigger}); note=${note}`);
    return { ok, note, approvalId: routedApprovalId };
  }

  const reason = `Second-pass agreement at HEAD ${reviewedHeadSha} did not merge: ${note || 'the merge dispatch returned no reason.'}`;
  recordLaneEvent(lane.id, 'merge_dispatch_failed', 'system', {
    packetId: lane.packetId ?? null,
    approvalId,
    reviewedHeadSha,
    trigger,
    note: note || null,
    reason,
    // A merge routed to an operator approval card already parked the lane in a
    // durable, operator-actionable state — the card IS the outcome. Only a
    // dispatch that produced no outcome at all needs the queue blocker to move
    // the lane out of the live-looking `reviewing` state.
    routedApprovalId,
  });
  if (!routedApprovalId) {
    surfaceReviewQueueBlocker({
      laneId: lane.id,
      reviewId: `second-pass-merge:${approvalId}`,
      reason,
      attempts: 0,
    });
  }
  console.warn(`[auto-review] ${reason}`);
  return { ok, note, approvalId: routedApprovalId };
}
