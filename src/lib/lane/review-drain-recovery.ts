/**
 * Review-queue claim + recovery, split out of `auto-review.ts`.
 *
 * These two run BEFORE any review does, and neither one depends on the review
 * execution below them — which is exactly why the recovery half must not sit
 * behind the drain's in-flight guard. A reviewer turn that never settles used
 * to pin that guard for the life of the process, disabling reclamation and
 * stall reconciliation along with it: the one hung attempt silently switched
 * off every path built to notice a hung attempt.
 */

import { getSqlite } from '@/lib/db';
import {
  laneReviewHeadSha,
  normalizeAttemptHeadSha,
  reclaimAbandonedReviewAttempts,
  reviewAttemptOwnerId,
} from './review-attempt-head';
import { reconcileReviewStalls } from './review-stall-reconcile';

/** Stall reconciliation is git-touching, so it runs on a slower cadence than the drain. */
const STALL_RECONCILE_INTERVAL_MS = 30_000;

let lastStallReconcileAt = 0;

function getDb() {
  return getSqlite();
}

export interface QueuedReview {
  id: string;
  lane_id: string;
  repo_path: string;
  attempts: number;
  head_sha: string | null;
}

/**
 * Claim the next pending row, stamping the lease (`claimed_at` + `claim_owner`)
 * and the HEAD the attempt is pinned to. Both are what make an abandoned or
 * superseded claim recoverable without a process restart — a claim that only
 * the claiming process could settle is exactly how a row sat `in_progress`
 * forever while every later enqueue bounced off it.
 */
export function claimNextReview(): QueuedReview | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, lane_id, repo_path, attempts, head_sha FROM review_queue
     WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`,
  ).get() as QueuedReview | undefined;

  if (!row) return null;

  // A row enqueued before v46 (or on a lane whose HEAD was unreadable then) is
  // keyed at claim time instead, so drift from here on is still detectable.
  const headSha = normalizeAttemptHeadSha(row.head_sha)
    ?? laneReviewHeadSha({ worktreePath: null, repoPath: row.repo_path })
    ?? null;

  db.prepare(
    `UPDATE review_queue
     SET status = 'in_progress', head_sha = ?, claimed_at = datetime('now'), claim_owner = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(headSha, reviewAttemptOwnerId(), row.id);

  return { ...row, head_sha: headSha };
}

let recoveryPassInFlight = false;

/**
 * Reclaim abandoned claims, then reconcile stalled lanes. Exported so real-path
 * tests can drive the recovery half without claiming a review.
 */
export async function runReviewRecoveryPass(): Promise<void> {
  if (recoveryPassInFlight) return;
  recoveryPassInFlight = true;
  try {
    try {
      reclaimAbandonedReviewAttempts();
    } catch (error) {
      console.warn('[auto-review] Abandoned review attempt reclamation failed:', error);
    }

    // Reconcile before claiming: a lane whose merge dispatch was missed, or
    // whose successor review was skipped, has no queue row left to carry it,
    // so nothing downstream would ever look at it again.
    const now = Date.now();
    if (now - lastStallReconcileAt >= STALL_RECONCILE_INTERVAL_MS) {
      lastStallReconcileAt = now;
      try {
        await reconcileReviewStalls();
      } catch (error) {
        console.warn('[auto-review] Review stall reconciliation failed:', error);
      }
    }
  } finally {
    recoveryPassInFlight = false;
  }
}
