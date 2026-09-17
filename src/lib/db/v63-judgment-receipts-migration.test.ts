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
});
