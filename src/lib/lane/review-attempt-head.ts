/**
 * Head-keyed review attempts (#1844 / #1856 recurrence).
 *
 * A `review_queue` row is a claim on reviewing ONE commit. Until v46 the row
 * did not record which commit, so the two states below were indistinguishable
 * from a live attempt:
 *
 *   - **Superseded.** A steer landed a successor commit while an attempt was in
 *     flight. That attempt is reviewing a diff that no longer exists, its
 *     verdict can only authorize a dead HEAD, and it still occupied the lane's
 *     single active-row slot — so `enqueueLaneReview()` answered "Review
 *     already in progress" and the successor HEAD never got a turn.
 *   - **Abandoned.** The process that claimed the row exited, or the awaited
 *     reviewer turn never settled. Nothing on disk knew the attempt was owed,
 *     and the only repair was a ws-server restart.
 *
 * Both now settle durably: a superseded attempt gets a terminal receipt keyed
 * to the HEAD that replaced it, and an abandoned claim is reclaimed against a
 * lease. Cancellation stays ATTEMPT-scoped — the specific review id is
 * cancelled, never the lane.
 */

import { execFileSync } from 'node:child_process';

import { getSqlite } from '@/lib/db';
import { recordLaneEvent } from './events';
import { cancelReviewAttempt } from './review-cancellation';
import { markReviewFailed } from './review-queue-settlement';
import type { Lane } from './types';

/** How long a claimed attempt may sit untouched before it is reclaimable. */
export const REVIEW_ATTEMPT_LEASE_MS = 15 * 60_000;

interface ActiveAttemptRow {
  id: string;
  status: 'pending' | 'in_progress';
  head_sha: string | null;
  attempts: number;
}

interface AbandonedAttemptRow {
  id: string;
  lane_id: string;
  attempts: number;
  claimed_at: string | null;
  claim_owner: string | null;
}

export function reviewAttemptOwnerId(): string {
  return `pid:${process.pid}`;
}

export function normalizeAttemptHeadSha(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * `enqueueLaneReview()` is synchronous and is the chokepoint every review
 * enqueue passes through, so the HEAD it keys rows to has to be readable
 * synchronously too. Failure is not fatal: an unreadable HEAD leaves rows
 * unkeyed, which is exactly the pre-v46 behaviour.
 */
export function readWorktreeHeadShaSync(cwd?: string | null): string | undefined {
  const path = cwd?.trim();
  if (!path) return undefined;
  try {
    return normalizeAttemptHeadSha(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path,
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch {
    return undefined;
  }
}

export function laneReviewHeadSha(lane: Pick<Lane, 'worktreePath' | 'repoPath'>): string | undefined {
  return readWorktreeHeadShaSync(lane.worktreePath || lane.repoPath);
}

/**
 * Settle every active attempt on the lane that is pinned to a commit other than
 * `currentHeadSha`. Returns how many rows settled.
 *
 * Rows with no recorded HEAD are left alone — they predate v46 and there is no
 * evidence they are stale.
 */
export function settleSupersededReviewAttempts(input: {
  lane: Pick<Lane, 'id' | 'packetId'>;
  currentHeadSha?: string;
  reason: string;
}): number {
  const currentHeadSha = normalizeAttemptHeadSha(input.currentHeadSha);
  if (!currentHeadSha) return 0;

  let settled = 0;
  try {
    const db = getSqlite();
    const active = db.prepare(
      `SELECT id, status, head_sha, attempts FROM review_queue
       WHERE lane_id = ? AND status IN ('pending', 'in_progress')`,
    ).all(input.lane.id) as ActiveAttemptRow[];

    for (const row of active) {
      const rowHead = normalizeAttemptHeadSha(row.head_sha);
      if (!rowHead || rowHead === currentHeadSha) continue;

      const note = `Superseded: ${input.reason} (reviewed HEAD ${rowHead}, current HEAD ${currentHeadSha}).`;
      db.prepare(
        `UPDATE review_queue
         SET status = 'completed', last_error = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(note, row.id);

      // Attempt-scoped: only the row that is actually pinned to the dead HEAD
      // is cancelled, so a successor attempt on the same lane still runs.
      if (row.status === 'in_progress') cancelReviewAttempt(row.id);

      recordLaneEvent(input.lane.id, 'review_superseded', 'system', {
        packetId: input.lane.packetId ?? null,
        reviewId: row.id,
        reviewedHeadSha: rowHead,
        currentHeadSha,
        previousStatus: row.status,
        reason: input.reason,
      });
      settled += 1;
    }
  } catch (error) {
    console.warn(
      `[auto-review] Could not settle superseded attempts for lane ${input.lane.id}:`,
      error,
    );
  }
  return settled;
}

/**
 * Reclaim claimed rows whose lease expired. Each reclaim leaves a durable
 * `review_attempt_abandoned` receipt and then goes back through the normal
 * failure ladder, so a row that keeps being abandoned escalates to a blocker
 * instead of looping.
 *
 * `leaseMs: 0` is the startup sweep — at boot no claim from a previous process
 * can still be live, so every claimed row is reclaimable.
 */
export function reclaimAbandonedReviewAttempts(options: {
  leaseMs?: number;
  nowMs?: number;
} = {}): number {
  const leaseMs = options.leaseMs ?? REVIEW_ATTEMPT_LEASE_MS;
  const nowMs = options.nowMs ?? Date.now();

  let reclaimed = 0;
  try {
    const db = getSqlite();
    const claimed = db.prepare(
      `SELECT id, lane_id, attempts, claimed_at, claim_owner FROM review_queue
       WHERE status = 'in_progress'`,
    ).all() as AbandonedAttemptRow[];

    for (const row of claimed) {
      const claimedAtMs = parseSqliteTimestamp(row.claimed_at);
      // No lease stamp means the row predates v46 or was claimed by a process
      // that never recorded ownership — either way nothing is keeping it alive.
      const expired = claimedAtMs === null || nowMs - claimedAtMs >= leaseMs;
      if (!expired) continue;

      recordLaneEvent(row.lane_id, 'review_attempt_abandoned', 'system', {
        reviewId: row.id,
        claimedAt: row.claimed_at,
        claimOwner: row.claim_owner,
        leaseMs,
        attempts: row.attempts,
      });
      db.prepare(
        `UPDATE review_queue SET claimed_at = NULL, claim_owner = NULL WHERE id = ?`,
      ).run(row.id);
      markReviewFailed(
        row.id,
        row.lane_id,
        `Review attempt was claimed at ${row.claimed_at ?? 'an unrecorded time'} and never settled.`,
        row.attempts + 1,
      );
      reclaimed += 1;
    }
  } catch (error) {
    console.warn('[auto-review] Could not reclaim abandoned review attempts:', error);
  }
  return reclaimed;
}

/** SQLite `datetime('now')` is UTC without a zone marker; Date.parse needs the Z. */
function parseSqliteTimestamp(value: string | null): number | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = Date.parse(withZone);
  return Number.isNaN(parsed) ? null : parsed;
}
