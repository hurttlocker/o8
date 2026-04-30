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

export interface QueueItem {
  queueId: string;
  sourceKind: string;
  sourceId: string;
  repoPath: string | null;
  body: string;
}

/**
 * Enqueue every `github_comments` row for `repoPath` that isn't already in
 * `facts_queue`. Idempotent — re-running adds zero rows when the queue is
 * already saturated. Returns the count of rows inserted.
 */
export function enqueueComments(repoPath: string): number {
  const sqlite = getSqlite();

  const rows = sqlite
    .prepare(
      `SELECT c.id AS source_id
       FROM github_comments c
       LEFT JOIN facts_queue q
         ON q.source_kind = 'github_comment'
        AND q.source_id = c.id
       WHERE c.repo_path = ?
         AND q.id IS NULL
         AND length(c.body) > 0`,
    )
    .all(repoPath) as Array<{ source_id: string }>;

  if (rows.length === 0) return 0;

  const insert = sqlite.prepare(
    `INSERT INTO facts_queue (id, source_kind, source_id, repo_path, enqueued_at)
     VALUES (?, 'github_comment', ?, ?, datetime('now'))`,
  );

  const tx = sqlite.transaction((items: typeof rows) => {
    for (const row of items) {
      insert.run(randomUUID(), row.source_id, repoPath);
    }
  });

  tx(rows);
  return rows.length;
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
