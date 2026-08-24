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
import { recordLaneEvent } from './events';
import {
  laneReviewHeadSha,
  normalizeAttemptHeadSha,
  reclaimAbandonedReviewAttempts,
  reviewAttemptOwnerId,
} from './review-attempt-head';
import { getLane, setLaneStatus } from './registry';
import { reconcileReviewStalls } from './review-stall-reconcile';
import { isReviewerSessionBusyMessage } from './review-transient-failure';

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
  claim_owner: string;
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
     WHERE status = 'pending' ORDER BY updated_at ASC, created_at ASC LIMIT 1`,
  ).get() as QueuedReview | undefined;

  if (!row) return null;

  // A row enqueued before v46 (or on a lane whose HEAD was unreadable then) is
  // keyed at claim time instead, so drift from here on is still detectable.
  const lane = getLane(row.lane_id);
  const currentHeadSha = lane
    ? laneReviewHeadSha(lane)
    : laneReviewHeadSha({ worktreePath: null, repoPath: row.repo_path });
  const headSha = normalizeAttemptHeadSha(row.head_sha) ?? currentHeadSha ?? null;

  const claimOwner = reviewAttemptOwnerId();
  const claimed = db.prepare(
    `UPDATE review_queue
     SET status = 'in_progress', head_sha = ?, claimed_at = datetime('now'), claim_owner = ?,
         updated_at = datetime('now')
     WHERE id = ? AND status = 'pending'`,
  ).run(headSha, claimOwner, row.id);
  if (claimed.changes !== 1) return null;

  return { ...row, head_sha: headSha, claim_owner: claimOwner };
}

/** True only while this exact claim generation still owns the queue row. */
export function isReviewClaimCurrent(review: Pick<QueuedReview, 'id' | 'claim_owner'>): boolean {
  const row = getDb().prepare(
    `SELECT 1 FROM review_queue
     WHERE id = ? AND status = 'in_progress' AND claim_owner = ?`,
  ).get(review.id, review.claim_owner);
  return Boolean(row);
}

interface TransientFailedReviewRow {
  id: string;
  lane_id: string;
  attempts: number;
  last_error: string | null;
}

/**
 * Repair rows created before reviewer contention had a structured outcome.
 * Only the exact known busy condition is eligible; real reviewer failures stay
 * failed and visible to the operator.
 */
async function recoverTransientReviewFailures(): Promise<number> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, lane_id, attempts, last_error FROM review_queue WHERE status = 'failed'`,
  ).all() as TransientFailedReviewRow[];
  let recovered = 0;

  for (const row of rows) {
    if (!isReviewerSessionBusyMessage(row.last_error)) continue;
    const lane = getLane(row.lane_id);
    if (!lane) continue;
    const currentHeadSha = laneReviewHeadSha(lane) ?? null;
    const reason = row.last_error?.trim() || 'Reviewer session busy';
    const result = db.prepare(
      `UPDATE review_queue
       SET status = 'pending', attempts = 0, last_error = ?, head_sha = ?,
           claimed_at = NULL, claim_owner = NULL, updated_at = datetime('now')
       WHERE id = ? AND status = 'failed' AND last_error = ?`,
    ).run(`Deferred after restart: ${reason}`, currentHeadSha, row.id, row.last_error);
    if (result.changes !== 1) continue;

    if (
      lane.status === 'awaiting_orchestrator'
      && lane.lastEventLabel === 'review_queue_failed'
    ) {
      setLaneStatus(lane.id, 'reviewing', 'system', 'review_queue_transient_recovered');
    }
    let releaseRepaired = false;
    if (lane.packetId) {
      const { repairUnprovenPacketRelease } = await import('@/lib/orchestrator/packet-release-repair');
      releaseRepaired = await repairUnprovenPacketRelease(lane.packetId, lane.id);
    }
    recordLaneEvent(lane.id, 'review_transient_recovered', 'system', {
      packetId: lane.packetId ?? null,
      reviewId: row.id,
      previousAttempts: row.attempts,
      reason,
      currentHeadSha,
      releaseRepaired,
    });
    recovered += 1;
  }
  return recovered;
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
      await recoverTransientReviewFailures();
    } catch (error) {
      console.warn('[auto-review] Transient review recovery failed:', error);
    }

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
