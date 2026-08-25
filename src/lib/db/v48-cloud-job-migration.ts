import type Database from 'better-sqlite3';

/** Schema v48: durable cloud jobs, worker leases, and ordered output events. */
export function ensureV48CloudJobSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS cloud_jobs (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      cursor INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      packet_id TEXT,
      launch_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      enqueued_at TEXT NOT NULL,
      claimed_at TEXT,
      claimed_by TEXT,
      lease_token TEXT,
      lease_expires_at INTEGER,
      claim_count INTEGER NOT NULL DEFAULT 0,
      lease_recovery_count INTEGER NOT NULL DEFAULT 0,
      execution_attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      CHECK (status IN ('pending', 'leased', 'completed', 'parked', 'cancelled'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_jobs_team_cursor
      ON cloud_jobs(team_id, cursor);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_jobs_team_idempotency
      ON cloud_jobs(team_id, idempotency_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_jobs_active_packet
      ON cloud_jobs(team_id, packet_id)
      WHERE packet_id IS NOT NULL AND status IN ('pending', 'leased');
    CREATE INDEX IF NOT EXISTS idx_cloud_jobs_claimable
      ON cloud_jobs(team_id, status, cursor);
    CREATE INDEX IF NOT EXISTS idx_cloud_jobs_lease_expiry
      ON cloud_jobs(status, lease_expires_at);

    CREATE TABLE IF NOT EXISTS cloud_job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES cloud_jobs(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      worker_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_job_events_job_id
      ON cloud_job_events(job_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_job_events_single_completion
      ON cloud_job_events(job_id)
      WHERE event_type IN ('completed', 'cancelled');
  `);
}
