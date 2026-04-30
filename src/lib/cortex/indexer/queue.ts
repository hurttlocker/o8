/**
 * Queue management for the Engineering Brain Indexer (#915 north star #2).
 *
 * Backed by `facts_queue` (schema v17). One row per (source_kind, source_id)
 * pair scheduled for distillation. Lifecycle:
 *
 *   enqueueComments(repoPath)  → seeds rows for every github_comments row that
 *                                isn't already in the queue.
 *   claimNext()                → atomic SELECT + UPDATE (started_at = now) on
 *                                the oldest unclaimed row.
 *   completeQueueItem(id)      → set completed_at.
 *   failQueueItem(id, err)     → bump attempts + last_error. After 3 attempts
 *                                the row is marked permanently failed (we set
 *                                completed_at + a poison-prefix on last_error
 *                                so the worker stops re-claiming it).
 *
 * The queue is FIFO by `enqueued_at` for unclaimed rows. `started_at` lets a
 * stuck worker be detected externally (it isn't auto-recovered here — a future
 * run can clear the field if needed).
 */

import 'server-only';

import { randomUUID } from 'node:crypto';

import { getSqlite } from '@/lib/db';

const POISON_PREFIX = 'permanent_failure: ';
const MAX_ATTEMPTS = 3;

// ── Heuristic noise filter — pre-enqueue ─────────────────────────────────────
//
// Drops conversational/empty comments BEFORE they hit the queue. Saves user
// CLI budget (Max plan minutes, Codex sub minutes) on garbage bodies that
// Sonnet would correctly return [] for after a 14-20s round-trip.
//
// Filters in order of cheapest first:
//   1. Length floor (80 chars). "lgtm", "thanks!", "👍" don't carry facts.
//   2. Bot author logins. dependabot/github-actions/claude bot comments
//      don't contain organizational decisions.
//   3. Pure emoji / quote-only bodies. A reply that's only `> someone's text`
//      or only emoji has nothing new to distill.
//
// Phase 2 may add: LLM triage pass for borderline (50-300 char) comments,
// updated_at delta detection for re-distilling edits.

const NOISE_AUTHOR_LOGINS = new Set<string>([
  'dependabot[bot]',
  'github-actions[bot]',
  'codecov[bot]',
  'codecov-commenter',
  'sweep-ai[bot]',
  'claude[bot]',
  'pre-commit-ci[bot]',
  'renovate[bot]',
  'snyk-bot',
  // o8's own automated PR bot (caught in cortex-ide corpus validation)
  'cortex-dev-agent[bot]',
]);

const MIN_BODY_LENGTH = 80;

/** Strip GitHub-flavored quote lines (`> ...`) and surrounding whitespace. */
function stripQuotedLines(body: string): string {
  return body
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .trim();
}

/** True if the body, after quote-stripping, is pure emoji/punctuation/noise. */
function isEmojiOrPunctuationOnly(body: string): boolean {
  const stripped = stripQuotedLines(body);
  if (stripped.length === 0) return true;
  // Remove all unicode emoji + punctuation + whitespace; if nothing left it's noise.
  const meaningful = stripped.replace(/[\p{Emoji}\p{Punctuation}\s]/gu, '');
  return meaningful.length < 8;
}

/**
 * Returns true if a comment body+author combo should be skipped at enqueue
 * time. Cheap, deterministic — no LLM call. The skip rate observed in
 * practice on cortex-ide + o8-site comments is ~30-50%.
 */
export function shouldSkipCommentForIndex(args: {
  body: string | null | undefined;
  authorLogin: string | null | undefined;
}): boolean {
  const body = (args.body ?? '').trim();
  if (body.length < MIN_BODY_LENGTH) return true;

  if (args.authorLogin && NOISE_AUTHOR_LOGINS.has(args.authorLogin)) return true;

  // After stripping quotes, if there's <80 chars left it's a thin reply.
  const withoutQuotes = stripQuotedLines(body);
  if (withoutQuotes.length < MIN_BODY_LENGTH) return true;

  if (isEmojiOrPunctuationOnly(body)) return true;

  return false;
}

export interface QueueItem {
  queueId: string;
  sourceKind: string;
  sourceId: string;
  repoPath: string | null;
  body: string;
}

/**
 * Enqueue every `github_comments` row for `repoPath` that isn't already in
 * `facts_queue` AND passes the heuristic noise filter. Idempotent —
 * re-running adds zero rows when the queue is already saturated.
 *
 * Re-enqueue when source has been edited upstream: any comment whose
 * `updated_at` is strictly newer than the most recent fact distilled from it
 * (`facts.created_at` for `source_id = comment.id`) gets a fresh queue row
 * (attempts=0, last_error=NULL). The existing fact stays in place until the
 * worker overwrites it via the fingerprint upsert; if the new content
 * fingerprints to the same row, the worker no-ops.
 *
 * Returns `{ enqueued, skipped }` so callers can see how many were filtered.
 */
export function enqueueComments(repoPath: string): { enqueued: number; skipped: number } {
  const sqlite = getSqlite();

  // Two pools of candidates:
  //   1. Brand-new comments: no facts_queue row at all.
  //   2. Edited comments: a queue row exists AND was completed AND the
  //      comment's updated_at is newer than the latest fact.created_at for
  //      that source. We compare against MAX(facts.created_at) so a comment
  //      that fanned out into multiple facts only re-enqueues once, after
  //      the last write is older than the upstream edit.
  const candidates = sqlite
    .prepare(
      `WITH last_fact_per_source AS (
         SELECT source_id, MAX(created_at) AS last_created_at
           FROM facts
          WHERE source_kind = 'github_comment'
          GROUP BY source_id
       )
       SELECT c.id AS source_id, c.body, c.author_login
         FROM github_comments c
         LEFT JOIN facts_queue q
           ON q.source_kind = 'github_comment'
          AND q.source_id = c.id
         LEFT JOIN last_fact_per_source f
           ON f.source_id = c.id
        WHERE c.repo_path = ?
          AND length(c.body) > 0
          AND (
            -- Brand-new: never queued.
            q.id IS NULL
            OR (
              -- Stale: queued + completed + upstream edited since last fact.
              q.completed_at IS NOT NULL
              AND f.last_created_at IS NOT NULL
              AND c.updated_at IS NOT NULL
              AND c.updated_at > f.last_created_at
            )
          )`,
    )
    .all(repoPath) as Array<{ source_id: string; body: string; author_login: string | null }>;

  if (candidates.length === 0) return { enqueued: 0, skipped: 0 };

  const enqueueRows = candidates.filter(
    (c) => !shouldSkipCommentForIndex({ body: c.body, authorLogin: c.author_login }),
  );
  const skipped = candidates.length - enqueueRows.length;

  if (enqueueRows.length === 0) return { enqueued: 0, skipped };

  // For brand-new sources we INSERT. For stale/edited sources we want a
  // fresh queue row regardless of whether the prior row exists, so the
  // claim/complete cycle re-runs. Use INSERT OR REPLACE on (source_kind,
  // source_id) — but `id` is the PK and we need to invalidate the old queue
  // row by matching on the source pair. Simplest path: DELETE prior queue
  // row(s) for the source, then INSERT fresh. Wrapped in a transaction so
  // the worker never sees a hole.
  const deleteStale = sqlite.prepare(
    `DELETE FROM facts_queue
       WHERE source_kind = 'github_comment'
         AND source_id = ?`,
  );
  const insert = sqlite.prepare(
    `INSERT INTO facts_queue (id, source_kind, source_id, repo_path, enqueued_at)
     VALUES (?, 'github_comment', ?, ?, datetime('now'))`,
  );

  const tx = sqlite.transaction((items: typeof enqueueRows) => {
    for (const row of items) {
      deleteStale.run(row.source_id);
      insert.run(randomUUID(), row.source_id, repoPath);
    }
  });

  tx(enqueueRows);
  return { enqueued: enqueueRows.length, skipped };
}

/**
 * Atomically claim the oldest unclaimed row. Reads + updates within a single
 * transaction so two workers never claim the same row.
 *
 * Returns null when the queue is empty (or every remaining row is poisoned /
 * in-flight by another worker — unlikely in v1 single-worker mode).
 */
export function claimNext(): QueueItem | null {
  const sqlite = getSqlite();

  let claimed: QueueItem | null = null;
  const tx = sqlite.transaction(() => {
    const row = sqlite
      .prepare(
        `SELECT q.id AS queue_id, q.source_kind, q.source_id, q.repo_path, c.body
         FROM facts_queue q
         JOIN github_comments c ON c.id = q.source_id
         WHERE q.completed_at IS NULL
           AND q.started_at IS NULL
           AND q.attempts < ${MAX_ATTEMPTS}
         ORDER BY q.enqueued_at ASC
         LIMIT 1`,
      )
      .get() as
      | {
          queue_id: string;
          source_kind: string;
          source_id: string;
          repo_path: string | null;
          body: string;
        }
      | undefined;

    if (!row) return;

    sqlite
      .prepare(`UPDATE facts_queue SET started_at = datetime('now') WHERE id = ?`)
      .run(row.queue_id);

    claimed = {
      queueId: row.queue_id,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      repoPath: row.repo_path,
      body: row.body,
    };
  });

  tx();
  return claimed;
}

/** Mark a queue row as successfully processed. */
export function completeQueueItem(queueId: string): void {
  const sqlite = getSqlite();
  sqlite
    .prepare(`UPDATE facts_queue SET completed_at = datetime('now') WHERE id = ?`)
    .run(queueId);
}

/**
 * Mark a queue row as failed for this attempt. Increments `attempts` + sets
 * `last_error`. If `attempts` reaches MAX_ATTEMPTS, the row is poisoned —
 * `completed_at` is stamped so the worker stops re-claiming it, and the
 * error is prefixed with `permanent_failure:` for forensics.
 *
 * Also clears `started_at` on retryable failures so a fresh `claimNext` can
 * pick the row up.
 */
export function failQueueItem(queueId: string, error: string): void {
  const sqlite = getSqlite();

  const row = sqlite
    .prepare(`SELECT attempts FROM facts_queue WHERE id = ?`)
    .get(queueId) as { attempts: number } | undefined;
  if (!row) return;

  const nextAttempts = row.attempts + 1;
  const truncated = error.slice(0, 800);

  if (nextAttempts >= MAX_ATTEMPTS) {
    sqlite
      .prepare(
        `UPDATE facts_queue
         SET attempts = ?, last_error = ?, completed_at = datetime('now')
         WHERE id = ?`,
      )
      .run(nextAttempts, `${POISON_PREFIX}${truncated}`, queueId);
  } else {
    // Retryable — clear started_at so the next claimNext picks it up.
    sqlite
      .prepare(
        `UPDATE facts_queue
         SET attempts = ?, last_error = ?, started_at = NULL
         WHERE id = ?`,
      )
      .run(nextAttempts, truncated, queueId);
  }
}

/** Number of rows still claimable by the worker. */
export function pendingQueueDepth(): number {
  const sqlite = getSqlite();
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS c FROM facts_queue
       WHERE completed_at IS NULL AND attempts < ${MAX_ATTEMPTS}`,
    )
    .get() as { c: number };
  return row.c;
}
