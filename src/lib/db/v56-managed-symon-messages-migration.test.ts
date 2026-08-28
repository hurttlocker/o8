import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureV56ManagedSymonMessagesSchema } from '@/lib/db/v56-managed-symon-messages-migration';

describe('v56 managed Symon Messages migration', () => {
  it('creates the durable conversation and turn tables idempotently', () => {
    const sqlite = new Database(':memory:');
    try {
      ensureV56ManagedSymonMessagesSchema(sqlite);
      ensureV56ManagedSymonMessagesSchema(sqlite);
      const tables = sqlite.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'managed_symon_%'
        ORDER BY name
      `).all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual([
        'managed_symon_conversations',
        'managed_symon_turns',
      ]);
    } finally {
      sqlite.close();
    }
  });
});
