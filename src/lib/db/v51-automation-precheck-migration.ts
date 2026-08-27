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

/** Schema v51: bounded, restart-safe automation precheck receipts. */
export function ensureV51AutomationPrecheckSchema(sqlite: Database.Database): void {
  addColumn(sqlite, 'automations', 'precheck_command', 'TEXT');
  addColumn(sqlite, 'automations', 'precheck_timeout_ms', 'INTEGER NOT NULL DEFAULT 10000');

  addColumn(sqlite, 'automation_fires', 'precheck_command', 'TEXT');
  addColumn(sqlite, 'automation_fires', 'precheck_timeout_ms', 'INTEGER');
  addColumn(sqlite, 'automation_fires', 'precheck_bypassed', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(sqlite, 'automation_fires', 'precheck_status', "TEXT NOT NULL DEFAULT 'none'");
  addColumn(sqlite, 'automation_fires', 'precheck_started_at', 'INTEGER');
  addColumn(sqlite, 'automation_fires', 'precheck_completed_at', 'INTEGER');
  addColumn(sqlite, 'automation_fires', 'precheck_duration_ms', 'INTEGER');
  addColumn(sqlite, 'automation_fires', 'precheck_exit_code', 'INTEGER');
  addColumn(sqlite, 'automation_fires', 'precheck_stdout_tail', 'TEXT');
  addColumn(sqlite, 'automation_fires', 'precheck_stderr_tail', 'TEXT');
  addColumn(sqlite, 'automation_fires', 'precheck_error_message', 'TEXT');
}
