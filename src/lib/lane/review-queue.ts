import { randomUUID } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import { recordLaneEvent } from '@/lib/lane/events';
import { getLane, setLaneStatus } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';

interface ActiveQueuedReview {
  id: string;
  status: 'pending' | 'in_progress';
}

export interface EnqueueLaneReviewOptions {
  /**
   * A review already running may be locked to the previous HEAD. Leave one
   * pending successor behind so the current-head approval gets its own turn.
   */
  afterInProgress?: boolean;
}

export interface EnqueueLaneReviewResult {
  reviewId: string;
  queued: boolean;
  status: 'pending' | 'in_progress';
}

export function enqueueLaneReview(
  lane: Lane,
  options: EnqueueLaneReviewOptions = {},
): EnqueueLaneReviewResult {
  const db = getSqlite();
  const active = db.prepare(
    `SELECT id, status FROM review_queue
     WHERE lane_id = ? AND status IN ('pending', 'in_progress')
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at ASC`,
  ).all(lane.id) as ActiveQueuedReview[];
  const pending = active.find((review) => review.status === 'pending');
  if (pending) {
    console.log(`[auto-review] Review already queued for lane ${lane.id}`);
    return { reviewId: pending.id, queued: false, status: 'pending' };
  }
  const inProgress = active.find((review) => review.status === 'in_progress');
  if (inProgress && !options.afterInProgress) {
    console.log(`[auto-review] Review already in progress for lane ${lane.id}`);
    return { reviewId: inProgress.id, queued: false, status: 'in_progress' };
  }

  const reviewId = `review-${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO review_queue (id, lane_id, repo_path, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, datetime('now'), datetime('now'))`,
  ).run(reviewId, lane.id, lane.repoPath);

  console.log(`[auto-review] Enqueued review ${reviewId} for lane ${lane.id} (${lane.label})`);
  return { reviewId, queued: true, status: 'pending' };
}

export function surfaceReviewQueueBlocker(input: {
  laneId: string;
  reviewId: string;
  reason: string;
  attempts: number;
}): void {
  const lane = getLane(input.laneId);
  if (!lane) return;

  if (
    lane.status !== 'completed'
    && lane.status !== 'archived'
    && lane.status !== 'awaiting_orchestrator'
    && lane.status !== 'awaiting_human'
  ) {
    setLaneStatus(lane.id, 'awaiting_orchestrator', 'system', 'review_queue_failed');
  }
  recordLaneEvent(lane.id, 'review_queue_blocked', 'system', {
    packetId: lane.packetId,
    reviewId: input.reviewId,
    reason: input.reason,
    attempts: input.attempts,
  });
}

// ── Terminal writers ──
// Every claimed row must reach a terminal state that carries a receipt: a
// review turn, an explicit skip reason, or a failure. A row that lands on
// `completed` with attempts=0 and last_error=NULL and no lane event is the
// silent-completion defect this owns (#1856).

export const MAX_REVIEW_ATTEMPTS = 5;

export function markReviewCompleted(reviewId: string): void {
  getSqlite().prepare(
    `UPDATE review_queue SET status = 'completed', updated_at = datetime('now') WHERE id = ?`,
  ).run(reviewId);
}

/**
 * A claimed review that never ran a reviewer turn. The reason is persisted on
 * the row AND emitted as a lane event so the ledger can never claim a review
 * happened when it did not.
 */
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
    // Return to pending for retry
    db.prepare(
      `UPDATE review_queue SET status = 'pending', last_error = ?, attempts = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(error, attempts, reviewId);
  }
}
