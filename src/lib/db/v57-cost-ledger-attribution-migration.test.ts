import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureV57CostLedgerAttributionSchema } from './v57-cost-ledger-attribution-migration';

function usageColumns(sqlite: Database.Database) {
  return sqlite.prepare('PRAGMA table_info(usage_logs)').all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
}

describe('v57 cost ledger attribution migration', () => {
  it('upgrades a previous-version table without inventing legacy attribution', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE usage_logs (
          id TEXT PRIMARY KEY,
          model TEXT NOT NULL,
          provider TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          billing_period TEXT NOT NULL
        );
        INSERT INTO usage_logs (id, model, provider, billing_period)
        VALUES ('legacy-row', 'legacy-model', 'runtime', '2026-08');
      `);

      ensureV57CostLedgerAttributionSchema(sqlite);
      ensureV57CostLedgerAttributionSchema(sqlite);

      const row = sqlite.prepare(`
        SELECT lane_id, packet_id, mission_id, role, attempt, run_id, metadata_json
        FROM usage_logs WHERE id = 'legacy-row'
      `).get();
      expect(row).toEqual({
        lane_id: null,
        packet_id: null,
        mission_id: null,
        role: null,
        attempt: 1,
        run_id: null,
        metadata_json: null,
      });
      expect(usageColumns(sqlite).find((column) => column.name === 'attempt')).toMatchObject({
        notnull: 1,
        dflt_value: '1',
      });
      expect(sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_usage_logs_packet_attempt'",
      ).get()).toEqual({ name: 'idx_usage_logs_packet_attempt' });
    } finally {
      sqlite.close();
    }
  });

  it('creates no partial schema when the base table does not exist', () => {
    const sqlite = new Database(':memory:');
    try {
      ensureV57CostLedgerAttributionSchema(sqlite);
      expect(usageColumns(sqlite)).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
