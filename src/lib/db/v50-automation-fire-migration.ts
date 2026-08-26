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

/** Schema v50: automation history backed by the shared durable execution spine. */
export function ensureV50AutomationFireSchema(sqlite: Database.Database): void {
  if (!columnExists(sqlite, 'automations', 'catch_up_policy')) {
    addColumn(sqlite, "ALTER TABLE automations ADD COLUMN catch_up_policy TEXT NOT NULL DEFAULT 'latest'");
  }
  if (!columnExists(sqlite, 'automations', 'repo_concurrency_limit')) {
    addColumn(sqlite, 'ALTER TABLE automations ADD COLUMN repo_concurrency_limit INTEGER NOT NULL DEFAULT 1');
  }
  if (!columnExists(sqlite, 'cloud_jobs', 'available_at')) {
    addColumn(sqlite, 'ALTER TABLE cloud_jobs ADD COLUMN available_at INTEGER');
  }
  if (!columnExists(sqlite, 'cloud_jobs', 'concurrency_key')) {
    addColumn(sqlite, 'ALTER TABLE cloud_jobs ADD COLUMN concurrency_key TEXT');
  }
  if (!columnExists(sqlite, 'cloud_jobs', 'concurrency_limit')) {
    addColumn(sqlite, 'ALTER TABLE cloud_jobs ADD COLUMN concurrency_limit INTEGER');
  }
  if (!columnExists(sqlite, 'cloud_jobs', 'concurrent_count')) {
    addColumn(sqlite, 'ALTER TABLE cloud_jobs ADD COLUMN concurrent_count INTEGER');
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS automation_fires (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      execution_job_id TEXT NOT NULL UNIQUE REFERENCES cloud_jobs(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      slot_ms INTEGER,
      idempotency_key TEXT NOT NULL UNIQUE,
      repo_path TEXT NOT NULL,
      repo_concurrency_limit INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      scheduled_at INTEGER NOT NULL,
      persisted_at INTEGER NOT NULL,
      lane_id TEXT,
      mission_id TEXT,
      result_note TEXT,
      completed_at INTEGER,
      schedule_delay_ms INTEGER,
      queue_delay_ms INTEGER,
      execution_ms INTEGER,
      concurrent_count INTEGER,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      CHECK (source IN ('scheduled', 'manual')),
      CHECK (status IN ('pending', 'leased', 'retrying', 'recovered', 'succeeded', 'parked', 'cancelled')),
      CHECK (repo_concurrency_limit > 0)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_fires_scheduled_slot
      ON automation_fires(automation_id, slot_ms)
      WHERE source = 'scheduled';
    CREATE INDEX IF NOT EXISTS idx_automation_fires_automation_history
      ON automation_fires(automation_id, scheduled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cloud_jobs_available
      ON cloud_jobs(team_id, status, available_at, cursor);
    CREATE INDEX IF NOT EXISTS idx_cloud_jobs_concurrency
      ON cloud_jobs(team_id, concurrency_key, status, lease_expires_at);

    CREATE TRIGGER IF NOT EXISTS trg_automation_fire_delete_execution_job
    AFTER DELETE ON automation_fires
    BEGIN
      DELETE FROM cloud_jobs WHERE id = OLD.execution_job_id AND team_id = 'automation';
    END;
  `);
}
