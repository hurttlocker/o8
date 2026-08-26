import type Database from 'better-sqlite3';

function columnExists(sqlite: Database.Database, table: string, column: string): boolean {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((candidate) => candidate.name === column);
}

function addColumn(sqlite: Database.Database, statement: string): void {
  try {
    sqlite.exec(statement);
  } catch (error) {
    if (error instanceof Error && /duplicate column name/i.test(error.message)) return;
    throw error;
  }
}

/** Schema v49: durable cloud controls, session serialization, and restart drain state. */
export function ensureV49CloudJobControlSchema(sqlite: Database.Database): void {
  if (!columnExists(sqlite, 'cloud_jobs', 'session_id')) {
    addColumn(sqlite, 'ALTER TABLE cloud_jobs ADD COLUMN session_id TEXT');
  }
  if (!columnExists(sqlite, 'cloud_jobs', 'parent_job_id')) {
    addColumn(sqlite, 'ALTER TABLE cloud_jobs ADD COLUMN parent_job_id TEXT');
  }

  sqlite.exec(`
    UPDATE cloud_jobs SET session_id = id WHERE session_id IS NULL OR session_id = '';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_jobs_active_session
      ON cloud_jobs(team_id, session_id)
      WHERE session_id IS NOT NULL AND status IN ('pending', 'leased');
    CREATE INDEX IF NOT EXISTS idx_cloud_jobs_session_cursor
      ON cloud_jobs(team_id, session_id, cursor);

    CREATE TABLE IF NOT EXISTS cloud_job_controls (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES cloud_jobs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      control_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      delivery_token TEXT,
      delivery_expires_at INTEGER,
      delivery_count INTEGER NOT NULL DEFAULT 0,
      follow_up_job_id TEXT REFERENCES cloud_jobs(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      applied_at TEXT,
      updated_at TEXT NOT NULL,
      CHECK (control_type IN ('steer', 'abort')),
      CHECK (status IN ('pending', 'delivered', 'applied', 'follow_up', 'superseded')),
      UNIQUE (job_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_job_controls_delivery
      ON cloud_job_controls(team_id, job_id, status, sequence);

    CREATE TABLE IF NOT EXISTS cloud_job_drain_state (
      team_id TEXT PRIMARY KEY,
      boot_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}
