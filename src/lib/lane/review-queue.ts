import { randomUUID } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import type { Lane } from '@/lib/lane/types';
import {
  laneReviewHeadSha,
  normalizeAttemptHeadSha,
  settleSupersededReviewAttempts,
} from './review-attempt-head';

export { surfaceReviewQueueBlocker } from './review-queue-blocker';

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
  /**
   * Worktree HEAD this enqueue is for. Read from the lane when omitted; pass it
   * explicitly when the caller already resolved it (or in tests with no git).
   */
  headSha?: string;
}

export interface EnqueueLaneReviewResult {
  reviewId: string;
  queued: boolean;
  status: 'pending' | 'in_progress';
  /** Attempts settled as superseded because they were pinned to an older HEAD. */
  supersededAttempts: number;
}

/**
 * The single chokepoint every review enqueue passes through.
 *
 * It resolves the lane's CURRENT HEAD first and settles any active attempt
 * pinned to a different commit. Without that step a steer that landed a
 * successor commit left the old attempt occupying the lane's one active-row
 * slot: this function answered "Review already in progress" forever, the
 * successor HEAD never got a turn, and the stall reconciler skipped the lane
 * because the dead row still counted as live (#1844 / #1856 recurrence).
 */
export function enqueueLaneReview(
  lane: Lane,
  options: EnqueueLaneReviewOptions = {},
): EnqueueLaneReviewResult {
  const db = getSqlite();
  const currentHeadSha = normalizeAttemptHeadSha(options.headSha) ?? laneReviewHeadSha(lane);
  const supersededAttempts = settleSupersededReviewAttempts({
    lane,
    currentHeadSha,
    reason: 'HEAD moved past the commit this review was claimed for',
  });

  const active = db.prepare(
    `SELECT id, status FROM review_queue
     WHERE lane_id = ? AND status IN ('pending', 'in_progress')
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at ASC`,
  ).all(lane.id) as ActiveQueuedReview[];
  const pending = active.find((review) => review.status === 'pending');
  if (pending) {
    console.log(`[auto-review] Review already queued for lane ${lane.id}`);
    return { reviewId: pending.id, queued: false, status: 'pending', supersededAttempts };
  }
  const inProgress = active.find((review) => review.status === 'in_progress');
  if (inProgress && !options.afterInProgress) {
    console.log(`[auto-review] Review already in progress for lane ${lane.id}`);
    return { reviewId: inProgress.id, queued: false, status: 'in_progress', supersededAttempts };
  }

  const reviewId = `review-${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO review_queue (id, lane_id, repo_path, status, attempts, head_sha, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?, datetime('now'), datetime('now'))`,
  ).run(reviewId, lane.id, lane.repoPath, currentHeadSha ?? null);

  console.log(`[auto-review] Enqueued review ${reviewId} for lane ${lane.id} (${lane.label})`);
  return { reviewId, queued: true, status: 'pending', supersededAttempts };
}
