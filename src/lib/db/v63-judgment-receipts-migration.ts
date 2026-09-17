import type Database from 'better-sqlite3';

/**
 * Schema v63 (#2434): receipts for typed judgment calls made outside a lane.
 *
 * A call with a lane in context records a `judgment` lane event instead; this
 * table holds the rest (approval cards without a lane, Brain routing). Every
 * row is one call, successful or not: the exact question set, the answers,
 * the provider model string, token usage, latency, attempts, and whether the
 * state was truncated to fit the budget or carried hidden text.
 */
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
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_judgment_receipts_packet ON judgment_receipts(packet_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_judgment_receipts_approval ON judgment_receipts(approval_id, created_at);
  `);
}
