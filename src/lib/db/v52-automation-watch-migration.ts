import type Database from 'better-sqlite3';

function columnExists(sqlite: Database.Database, table: string, column: string): boolean {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((candidate) => candidate.name === column);
}

function addColumn(sqlite: Database.Database, table: string, column: string, definition: string): void {
  if (columnExists(sqlite, table, column)) return;
  try {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (error instanceof Error && /duplicate column name/i.test(error.message)) return;
    throw error;
  }
}

/** Schema v52: durable event sources, per-watch checkpoints, and auditable watch fires. */
export function ensureV52AutomationWatchSchema(sqlite: Database.Database): void {
  addColumn(sqlite, 'automations', 'watch_source_kind', 'TEXT');
  addColumn(sqlite, 'automations', 'watch_source_id', 'TEXT');
  addColumn(sqlite, 'automations', 'watch_event_types_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumn(sqlite, 'automations', 'watch_literal_filter', 'TEXT');
  addColumn(sqlite, 'automations', 'watch_quiet_ms', 'INTEGER');
  addColumn(sqlite, 'automations', 'watch_min_interval_ms', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(sqlite, 'automations', 'watch_batch_window_ms', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(sqlite, 'automations', 'watch_max_fires_per_tick', 'INTEGER NOT NULL DEFAULT 4');
  addColumn(sqlite, 'automations', 'watch_expires_at', 'INTEGER');
  addColumn(sqlite, 'automations', 'watch_action_kind', "TEXT NOT NULL DEFAULT 'dispatch'");
  addColumn(sqlite, 'automations', 'watch_target_lane_id', 'TEXT');
  addColumn(sqlite, 'automations', 'watch_checkpoint', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(sqlite, 'automations', 'watch_last_fire_at', 'INTEGER');

  addColumn(sqlite, 'automation_fires', 'trigger_source', 'TEXT');
  addColumn(sqlite, 'automation_fires', 'source_event_id', 'INTEGER');
  addColumn(sqlite, 'automation_fires', 'source_kind', 'TEXT');
  addColumn(sqlite, 'automation_fires', 'source_id', 'TEXT');
  addColumn(sqlite, 'automation_fires', 'source_event_type', 'TEXT');
  addColumn(sqlite, 'automation_fires', 'source_fingerprint', 'TEXT');
  addColumn(sqlite, 'automation_fires', 'source_payload_json', 'TEXT');
  addColumn(sqlite, 'automation_fires', 'action_kind', "TEXT NOT NULL DEFAULT 'dispatch'");
  addColumn(sqlite, 'automation_fires', 'target_lane_id', 'TEXT');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS automation_source_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      repo_path TEXT,
      event_type TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      persisted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automation_source_events_watch
      ON automation_source_events(source_kind, repo_path, sequence);
    CREATE INDEX IF NOT EXISTS idx_automation_source_events_identity
      ON automation_source_events(source_kind, source_id, sequence);

    CREATE TABLE IF NOT EXISTS automation_source_ingest_state (
      source_kind TEXT PRIMARY KEY,
      checkpoint INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
}
