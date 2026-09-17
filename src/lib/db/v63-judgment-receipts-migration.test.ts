import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureV63JudgmentReceiptsSchema } from './v63-judgment-receipts-migration';

describe('judgment receipts migration', () => {
  it('creates the receipts table idempotently', () => {
    const sqlite = new Database(':memory:');
    try {
      ensureV63JudgmentReceiptsSchema(sqlite);
      ensureV63JudgmentReceiptsSchema(sqlite);
      const columns = (sqlite.prepare('PRAGMA table_info(judgment_receipts)').all() as Array<{ name: string }>)
        .map((column) => column.name);
      expect(columns).toEqual([
        'id', 'provider', 'model', 'ok', 'questions_json', 'answers_json', 'input_tokens', 'output_tokens',
        'latency_ms', 'attempts', 'truncated', 'hidden_text', 'error_json', 'packet_id', 'lane_id', 'approval_id', 'surface', 'created_at',
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('adds the columns a pre-existing table is missing (#2459)', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE judgment_receipts (
          id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT, ok INTEGER NOT NULL,
          questions_json TEXT NOT NULL, answers_json TEXT, input_tokens INTEGER, output_tokens INTEGER,
          latency_ms INTEGER NOT NULL, attempts INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0,
          error_json TEXT, packet_id TEXT, lane_id TEXT, approval_id TEXT, surface TEXT, created_at TEXT NOT NULL
        );
      `);
      ensureV63JudgmentReceiptsSchema(sqlite);
      const columns = sqlite.prepare('PRAGMA table_info(judgment_receipts)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
      expect(columns.find((column) => column.name === 'hidden_text')).toMatchObject({ notnull: 1, dflt_value: '0' });
      expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_judgment_receipts%' ORDER BY name`).all())
        .toEqual([{ name: 'idx_judgment_receipts_approval' }, { name: 'idx_judgment_receipts_packet' }]);
    } finally {
      sqlite.close();
    }
  });
});
