import type Database from 'better-sqlite3';

function columnExists(sqlite: Database.Database, table: string, column: string): boolean {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((candidate) => candidate.name === column);
}

/**
 * Schema v64 (#2443): a Symon watch may carry an operator-authored condition
 * that the judgment referee answers yes/no on each tick. The condition text
 * and the last evaluation (p, time, streak, receipt id) live on the watch row;
 * a row with a condition is skipped by the exact-event materializer.
 */
export function ensureV64SymonFuzzyWatchSchema(sqlite: Database.Database): void {
  for (const column of ['symon_fuzzy_condition', 'symon_fuzzy_evaluation_json']) {
    if (columnExists(sqlite, 'automations', column)) continue;
    try {
      sqlite.exec(`ALTER TABLE automations ADD COLUMN ${column} TEXT`);
    } catch (error) {
      if (!(error instanceof Error && /duplicate column name/i.test(error.message))) throw error;
    }
  }
}
