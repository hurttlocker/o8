import type Database from 'better-sqlite3';

/** Schema v47: optional explainers use a queue independent of review attempts. */
export function ensureV47ExplainerQueueSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS explainer_queue (
      id TEXT PRIMARY KEY,
      packet_id TEXT NOT NULL,
      lane_id TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      contention_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      backend TEXT,
      queue_wait_ms INTEGER,
      turn_duration_ms INTEGER,
      approximate_cost REAL,
      outcome TEXT,
      claimed_at TEXT,
      claim_owner TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_explainer_queue_status
      ON explainer_queue(status);
    CREATE INDEX IF NOT EXISTS idx_explainer_queue_packet_status
      ON explainer_queue(packet_id, status);
  `);
}
