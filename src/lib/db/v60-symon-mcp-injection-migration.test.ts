import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ensureV60SymonMcpInjectionSchema } from './v60-symon-mcp-injection-migration';

describe('Symon MCP injection migration', () => {
  it('adds the opt-in column idempotently with a false default', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE external_mcp_servers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          transport TEXT NOT NULL,
          command TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO external_mcp_servers (id, name, transport, command)
          VALUES ('existing', 'existing-server', 'stdio', 'node');
      `);

      ensureV60SymonMcpInjectionSchema(sqlite);
      ensureV60SymonMcpInjectionSchema(sqlite);

      const columns = sqlite.prepare('PRAGMA table_info(external_mcp_servers)').all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      expect(columns.find((column) => column.name === 'symon_injection')).toMatchObject({
        notnull: 1,
        dflt_value: '0',
      });
      expect(sqlite.prepare(
        'SELECT symon_injection FROM external_mcp_servers WHERE id = ?',
      ).get('existing')).toEqual({ symon_injection: 0 });
    } finally {
      sqlite.close();
    }
  });
});
