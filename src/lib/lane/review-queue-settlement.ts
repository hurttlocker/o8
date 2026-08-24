/**
 * Durable terminal writers for claimed auto-review queue rows.
 *
 * Every claimed row must end with a reviewer turn, an explicit skip receipt,
 * or a failure. A bare `completed` row with no receipt is never acceptable.
 */

import { getSqlite } from '@/lib/db';
import { recordLaneEvent } from './events';
import { getLane } from './registry';
import { surfaceReviewQueueBlocker } from './review-queue';

export const MAX_REVIEW_ATTEMPTS = 5;

export function markReviewCompleted(reviewId: string): void {
  getSqlite().prepare(
    `UPDATE review_queue SET status = 'completed', updated_at = datetime('now') WHERE id = ?`,
  ).run(reviewId);
}

/** Persist why a claimed row ended without running a reviewer turn. */
export function markReviewSkipped(input: {
  reviewId: string;
  laneId: string;
  reason: string;
}): void {
  getSqlite().prepare(
    `UPDATE review_queue
     SET status = 'completed', last_error = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(`Skipped: ${input.reason}`, input.reviewId);

  const lane = getLane(input.laneId);
  recordLaneEvent(input.laneId, 'review_skipped', 'system', {
    packetId: lane?.packetId ?? null,
    reviewId: input.reviewId,
    reason: input.reason,
  });
}

export function markReviewFailed(reviewId: string, laneId: string, error: string, attempts: number): void {
  const db = getSqlite();
  if (attempts >= MAX_REVIEW_ATTEMPTS) {
    db.prepare(
      `UPDATE review_queue SET status = 'failed', last_error = ?, attempts = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(error, attempts, reviewId);
    surfaceReviewQueueBlocker({ laneId, reviewId, reason: error, attempts });
  } else {
    db.prepare(
      `UPDATE review_queue SET status = 'pending', last_error = ?, attempts = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(error, attempts, reviewId);
  }
}
