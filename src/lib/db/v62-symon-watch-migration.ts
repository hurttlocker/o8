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

/**
 * Schema v62: Symon-facing standing watches ride the existing durable watch
 * engine. A watch is an ordinary `automations` row; these columns carry the
 * Symon session that asked for it, the `then` body it runs, and the park stamp
 * that holds a fire until the phone is back.
 */
export function ensureV62SymonWatchSchema(sqlite: Database.Database): void {
  addColumn(sqlite, 'automations', 'symon_session_id', 'TEXT');
  addColumn(sqlite, 'automations', 'symon_then_json', 'TEXT');
  addColumn(sqlite, 'automations', 'symon_parked_at', 'INTEGER');
  addColumn(sqlite, 'automations', 'symon_parked_fire_id', 'TEXT');
  // The nudge stamp is the delivery claim: it is set by whichever drain wins
  // the conditional UPDATE, so a parked watch announces itself once and two
  // overlapping drains cannot both speak.
  addColumn(sqlite, 'automations', 'symon_nudged_at', 'INTEGER');
  addColumn(sqlite, 'automations', 'symon_run_claimed_at', 'INTEGER');
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_automations_symon_watch
      ON automations(symon_session_id, symon_parked_at);
  `);
}
