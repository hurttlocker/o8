import type Database from 'better-sqlite3';

/**
 * Schema v63 (#2434): receipts for typed judgment calls made outside a lane.
 *
 * A call with a lane in context records a `judgment` lane event instead; this
 * table holds the rest (approval cards without a lane, Brain routing). Every
 * row is one call, successful or not: the exact question set, the answers,
 * the provider model string, token usage, latency, attempts, and whether the
 * state was truncated to fit the budget or carried hidden text.
 *
 * `CREATE TABLE IF NOT EXISTS` alone is not enough (#2459): an install whose
 * database already holds an earlier shape of this table — written by an
 * intermediate build of the same feature — keeps that shape forever, and
 * every receipt insert fails on the missing column. The create is therefore
 * followed by a reconcile against REQUIRED_COLUMNS, so each column the
 * current shape needs and the table lacks is added. Add the next column to
 * both the create and that list and existing installs pick it up on boot.
 */

/** Columns the insert in `judgment/receipts.ts` writes, with their definitions. */
const REQUIRED_COLUMNS: Array<[column: string, definition: string]> = [
  ['id', 'TEXT'],
  ['provider', 'TEXT'],
  ['model', 'TEXT'],
  ['ok', 'INTEGER NOT NULL DEFAULT 0'],
  ['questions_json', 'TEXT'],
  ['answers_json', 'TEXT'],
  ['input_tokens', 'INTEGER'],
  ['output_tokens', 'INTEGER'],
  ['latency_ms', 'INTEGER NOT NULL DEFAULT 0'],
  ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['truncated', 'INTEGER NOT NULL DEFAULT 0'],
  ['hidden_text', 'INTEGER NOT NULL DEFAULT 0'],
  ['error_json', 'TEXT'],
  ['packet_id', 'TEXT'],
  ['lane_id', 'TEXT'],
  ['approval_id', 'TEXT'],
  ['surface', 'TEXT'],
  ['created_at', 'TEXT'],
  ['route', 'TEXT'],
  ['selection_json', 'TEXT'],
];

export function ensureV63JudgmentReceiptsSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS judgment_receipts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT,
      ok INTEGER NOT NULL,
      questions_json TEXT NOT NULL,
      answers_json TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      latency_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      truncated INTEGER NOT NULL DEFAULT 0,
      hidden_text INTEGER NOT NULL DEFAULT 0,
      error_json TEXT,
      packet_id TEXT,
      lane_id TEXT,
      approval_id TEXT,
      surface TEXT,
      created_at TEXT NOT NULL,
      route TEXT,
      selection_json TEXT
    );
  `);

  const present = new Set((sqlite.prepare('PRAGMA table_info(judgment_receipts)').all() as Array<{ name: string }>)
    .map((entry) => entry.name));
  for (const [column, definition] of REQUIRED_COLUMNS) {
    if (present.has(column)) continue;
    try {
      // A column added to a live table cannot carry the create's NOT NULL
      // without a default; every NOT NULL entry above supplies one.
      sqlite.exec(`ALTER TABLE judgment_receipts ADD COLUMN ${column} ${definition}`);
    } catch (error) {
      // Three processes open this database and migrate at boot; the loser of
      // that race sees the column it wanted, which is the desired end state.
      if (!(error instanceof Error && /duplicate column name/i.test(error.message))) throw error;
    }
  }

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_judgment_receipts_packet ON judgment_receipts(packet_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_judgment_receipts_approval ON judgment_receipts(approval_id, created_at);
  `);
}
