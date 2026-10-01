import type Database from 'better-sqlite3';

/** Authenticated external worker sightings used for honest dispatch readiness. */
export function ensureV66CloudWorkerPresenceSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS cloud_worker_presence (
      team_id TEXT NOT NULL,
      key_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, key_id, worker_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_worker_presence_seen
      ON cloud_worker_presence(last_seen_at);
  `);
}
