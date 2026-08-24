import type Database from 'better-sqlite3';

/**
 * Schema v46: head-keyed, leased auto-review attempts (#1844 / #1856).
 *
 * A `review_queue` row is a claim on reviewing ONE commit, but the row never
 * recorded which commit. So a steer that moved HEAD left the old attempt
 * indistinguishable from a live one: it could not be settled, it blocked the
 * successor enqueue, and it blinded the stall reconciler built to repair
 * exactly that shape. `head_sha` makes drift detectable; `claimed_at` +
 * `claim_owner` make an abandoned claim reclaimable without a process restart.
 * The owner includes a per-claim nonce so a late continuation cannot settle a
 * replacement generation that reused the same queue-row id.
 */
export function ensureV46ReviewAttemptHeadSchema(sqlite: Database.Database): void {
  // Idempotent and order-independent: `ensureTables()` is marker-gated, so on a
  // DB whose marker is already written this may run before the table exists.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS review_queue (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const existing = new Set(
    (sqlite.prepare(`PRAGMA table_info(review_queue)`).all() as { name: string }[])
      .map((column) => column.name),
  );
  if (!existing.has('head_sha')) sqlite.exec(`ALTER TABLE review_queue ADD COLUMN head_sha TEXT`);
  if (!existing.has('claimed_at')) sqlite.exec(`ALTER TABLE review_queue ADD COLUMN claimed_at TEXT`);
  if (!existing.has('claim_owner')) sqlite.exec(`ALTER TABLE review_queue ADD COLUMN claim_owner TEXT`);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_review_queue_lane_status ON review_queue(lane_id, status);
  `);
}
