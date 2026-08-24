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
import { reviewCancellationRegistry } from './review-cancellation-state';
export { cancelReviewAttempt } from './review-cancellation-state';

/** Claimed review attempts cancelled mid-flight. Cleared when the attempt settles. */
const cancelledReviewAttempts = reviewCancellationRegistry;

export function cancelAutoReviewForLane(laneId: string, reason: string): void {
  try {
    const db = getSqlite();
    const claimed = db.prepare(
      `SELECT id FROM review_queue WHERE lane_id = ? AND status = 'in_progress'`,
    ).all(laneId) as { id: string }[];
    for (const row of claimed) cancelledReviewAttempts.add(row.id);

    db.prepare(
      `UPDATE review_queue
       SET status = 'completed', last_error = ?, updated_at = datetime('now')
       WHERE lane_id = ? AND status IN ('pending', 'in_progress')`,
    ).run(`Cancelled: ${reason}`, laneId);
  } catch (error) {
    console.warn(`[auto-review] Failed to persist cancellation for lane ${laneId}:`, error);
  }
}

export function isReviewAttemptCancelled(reviewId: string, claimOwner?: string | null): boolean {
  return cancelledReviewAttempts.has(reviewId, claimOwner);
}

export function clearReviewAttemptCancellation(reviewId: string, claimOwner?: string | null): void {
  cancelledReviewAttempts.delete(reviewId, claimOwner);
}
