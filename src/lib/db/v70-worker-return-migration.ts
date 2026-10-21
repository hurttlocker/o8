import type Database from 'better-sqlite3';

/** Delivery records refer to shared-team membership; they never grant worker ownership. */
export function ensureV70WorkerReturnSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS shared_worker_return_stops (
      repo_path TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      stopped_at INTEGER NOT NULL, PRIMARY KEY(repo_path, thread_id, turn_id)
    );
    CREATE TABLE IF NOT EXISTS shared_worker_parents (
      surface_id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      origin_json TEXT NOT NULL,
      stopped_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shared_worker_returns (
      id TEXT PRIMARY KEY,
      surface_id TEXT NOT NULL REFERENCES shared_worker_parents(surface_id),
      run_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(surface_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_shared_worker_returns_pending
      ON shared_worker_returns(status, created_at);
  `);
}
