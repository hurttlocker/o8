import type Database from 'better-sqlite3';

export function ensureV71ComposerQueueSchema(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS composer_send_queue (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    repo_path TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    intent TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    admitted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_composer_send_queue_target
    ON composer_send_queue(repo_path, thread_id, status, sequence);`);
}
