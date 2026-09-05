import type Database from 'better-sqlite3';

function columnExists(sqlite: Database.Database, table: string, column: string): boolean {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((candidate) => candidate.name === column);
}

/** Schema v60: explicit operator opt-in for Symon MCP attachment. */
export function ensureV60SymonMcpInjectionSchema(sqlite: Database.Database): void {
  if (columnExists(sqlite, 'external_mcp_servers', 'symon_injection')) return;
  try {
    sqlite.exec(
      'ALTER TABLE external_mcp_servers ADD COLUMN symon_injection INTEGER NOT NULL DEFAULT 0',
    );
  } catch (error) {
    if (error instanceof Error && /duplicate column name/i.test(error.message)) return;
    throw error;
  }
}
