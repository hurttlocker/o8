import type Database from 'better-sqlite3';

const LEAD_COLUMNS: Array<[string, string]> = [
  ['result_turn_id', 'TEXT'],
];

const TURN_COLUMNS: Array<[string, string]> = [
  ['owner_identity_json', 'TEXT'],
  ['lease_token', 'TEXT'],
  ['lease_heartbeat_at', 'INTEGER'],
  ['outcome_kind', 'TEXT'],
  ['outcome_summary', 'TEXT'],
  ['outcome_evidence_json', 'TEXT'],
  ['outcome_reported_at', 'INTEGER'],
];

function ensureColumns(
  sqlite: Database.Database,
  table: string,
  columns: Array<[string, string]>,
): void {
  const present = new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name));
  for (const [column, definition] of columns) {
    if (present.has(column)) continue;
    try {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (error) {
      if (!(error instanceof Error && /duplicate column name/i.test(error.message))) throw error;
    }
  }
}

/** Durable lead conversations and replay-safe turn admission (#2541). */
export function ensureV65OrchestratorLeadSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS orchestrator_leads (
      id TEXT PRIMARY KEY,
      start_key TEXT NOT NULL UNIQUE,
      request_digest TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      repo_path TEXT NOT NULL,
      backend TEXT NOT NULL,
      model TEXT NOT NULL,
      effort TEXT NOT NULL,
      status TEXT NOT NULL,
      current_turn_id TEXT,
      result_turn_id TEXT,
      result_status TEXT,
      result_text TEXT,
      error TEXT,
      stop_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orchestrator_lead_turns (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES orchestrator_leads(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      brief_json TEXT,
      status TEXT NOT NULL,
      result_text TEXT,
      error TEXT,
      session_id TEXT,
      owner_pid INTEGER,
      owner_identity_json TEXT,
      lease_token TEXT,
      lease_heartbeat_at INTEGER,
      outcome_kind TEXT,
      outcome_summary TEXT,
      outcome_evidence_json TEXT,
      outcome_reported_at INTEGER,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      UNIQUE(lead_id, idempotency_key),
      UNIQUE(lead_id, ordinal)
    );

    CREATE TABLE IF NOT EXISTS orchestrator_lead_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id TEXT NOT NULL REFERENCES orchestrator_leads(id) ON DELETE CASCADE,
      turn_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orchestrator_lead_turns_queue
      ON orchestrator_lead_turns(lead_id, status, ordinal);
    CREATE INDEX IF NOT EXISTS idx_orchestrator_lead_events_cursor
      ON orchestrator_lead_events(lead_id, cursor);
  `);
  ensureColumns(sqlite, 'orchestrator_leads', LEAD_COLUMNS);
  ensureColumns(sqlite, 'orchestrator_lead_turns', TURN_COLUMNS);
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestrator_lead_one_running
      ON orchestrator_lead_turns(lead_id) WHERE status = 'running';
  `);
}
