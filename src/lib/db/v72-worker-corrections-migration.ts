import type Database from 'better-sqlite3';

export function ensureV72WorkerCorrectionsSchema(sqlite: Database.Database): void {
  sqlite.transaction(() => {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS session_rules (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, text TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    const columns = sqlite.prepare('PRAGMA table_info(session_rules)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'constraint_kind')) sqlite.exec('ALTER TABLE session_rules ADD COLUMN constraint_kind TEXT');
    sqlite.exec(`CREATE TABLE IF NOT EXISTS worker_correction_fences (
      scope TEXT PRIMARY KEY, generation INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_corrections (
      id TEXT PRIMARY KEY, repo_path TEXT NOT NULL, thread_id TEXT NOT NULL,
      payload_json TEXT NOT NULL, rule_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_correction_deliveries (
      correction_id TEXT NOT NULL REFERENCES worker_corrections(id), surface_id TEXT NOT NULL,
      run_id TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (correction_id, surface_id)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_corrections_thread ON worker_corrections(thread_id, created_at);`);
  })();
}
