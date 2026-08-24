/**
 * Attempt-scoped review cancellation (#1856).
 *
 * Cancellation used to add a lane id to a module-global set with no delete
 * path. That tombstone outlived the attempt it cancelled, so every LATER
 * review job on the same lane was skipped for the rest of the process — and
 * the drain still persisted those jobs as `completed`. A lane id is not a
 * lifetime kill switch; only the specific attempt in flight is cancellable.
 *
 * Pending rows are cancelled DURABLY in SQL (they can never be claimed after
 * that), so the in-memory set only ever needs to hold review ids that were
 * already claimed — and the drain clears each one when the attempt settles.
 */

import { getSqlite } from '@/lib/db';

/** Claimed review generations cancelled mid-flight. Cleared when that generation settles. */
const cancelledReviewAttempts = new Set<string>();

function cancellationKey(reviewId: string, claimOwner?: string | null): string {
  return claimOwner ? `${reviewId}\u0000${claimOwner}` : reviewId;
}

export function cancelAutoReviewForLane(laneId: string, reason: string): void {
  try {
    const db = getSqlite();
    const claimed = db.prepare(
      `SELECT id, claim_owner FROM review_queue WHERE lane_id = ? AND status = 'in_progress'`,
    ).all(laneId) as Array<{ id: string; claim_owner: string | null }>;
    for (const row of claimed) {
      cancelledReviewAttempts.add(cancellationKey(row.id, row.claim_owner));
    }

    db.prepare(
      `UPDATE review_queue
       SET status = 'completed', last_error = ?, claimed_at = NULL, claim_owner = NULL,
           updated_at = datetime('now')
       WHERE lane_id = ? AND status IN ('pending', 'in_progress')`,
    ).run(`Cancelled: ${reason}`, laneId);
  } catch (error) {
    console.warn(`[auto-review] Failed to persist cancellation for lane ${laneId}:`, error);
  }
}

/**
 * Cancel ONE claimed attempt without touching the lane's other rows. Used when
 * HEAD drifts past the commit an attempt is pinned to: that attempt is dead,
 * every later attempt on the lane is not.
 */
export function cancelReviewAttempt(reviewId: string, claimOwner?: string | null): void {
  cancelledReviewAttempts.add(cancellationKey(reviewId, claimOwner));
}

export function isReviewAttemptCancelled(reviewId: string, claimOwner?: string | null): boolean {
  if (claimOwner) {
    return cancelledReviewAttempts.has(cancellationKey(reviewId, claimOwner))
      || cancelledReviewAttempts.has(reviewId);
  }
  if (cancelledReviewAttempts.has(reviewId)) return true;
  const prefix = `${reviewId}\u0000`;
  return [...cancelledReviewAttempts].some((key) => key.startsWith(prefix));
}

export function clearReviewAttemptCancellation(reviewId: string, claimOwner?: string | null): void {
  cancelledReviewAttempts.delete(cancellationKey(reviewId, claimOwner));
}
