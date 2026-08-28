import type Database from 'better-sqlite3';

const USAGE_LOG_COLUMNS = [
  ['lane_id', 'TEXT'],
  ['packet_id', 'TEXT'],
  ['mission_id', 'TEXT'],
  ['role', 'TEXT'],
  ['attempt', 'INTEGER NOT NULL DEFAULT 1'],
  ['run_id', 'TEXT'],
  ['metadata_json', 'TEXT'],
] as const;

function columnExists(sqlite: Database.Database, column: string): boolean {
  const columns = sqlite.prepare('PRAGMA table_info(usage_logs)').all() as Array<{ name: string }>;
  return columns.some((candidate) => candidate.name === column);
}

function addColumnTolerant(sqlite: Database.Database, column: string, definition: string): void {
  if (columnExists(sqlite, column)) return;
  try {
    sqlite.exec(`ALTER TABLE usage_logs ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (error instanceof Error && /duplicate column name/i.test(error.message)) return;
    throw error;
  }
}

/** Schema v57: packet, attempt, run, and role attribution for metered model calls. */
export function ensureV57CostLedgerAttributionSchema(sqlite: Database.Database): void {
  const table = sqlite.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'usage_logs'",
  ).get() as { present: number } | undefined;
  if (!table) return;

  for (const [column, definition] of USAGE_LOG_COLUMNS) {
    addColumnTolerant(sqlite, column, definition);
  }
  sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_usage_logs_packet_attempt ON usage_logs(packet_id, attempt)',
  );
}
