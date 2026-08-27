import type Database from 'better-sqlite3';

function columnExists(sqlite: Database.Database, table: string, column: string): boolean {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((candidate) => candidate.name === column);
}

/** Schema v54: explicit operator opt-in for worker MCP attachment. */
export function ensureV54WorkerMcpInjectionSchema(sqlite: Database.Database): void {
  if (columnExists(sqlite, 'external_mcp_servers', 'worker_injection')) return;
  try {
    sqlite.exec(
      'ALTER TABLE external_mcp_servers ADD COLUMN worker_injection INTEGER NOT NULL DEFAULT 0',
    );
  } catch (error) {
    if (error instanceof Error && /duplicate column name/i.test(error.message)) return;
    throw error;
  }
}
