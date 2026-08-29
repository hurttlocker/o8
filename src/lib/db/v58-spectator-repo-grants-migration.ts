import type Database from 'better-sqlite3';

import { ensureV44BroadcastSchema } from './v44-broadcast-migration';

function columnExists(sqlite: Database.Database, column: string): boolean {
  const columns = sqlite.prepare('PRAGMA table_info(broadcast_tokens)').all() as Array<{ name: string }>;
  return columns.some((candidate) => candidate.name === column);
}

/** Schema v58: repository-scoped spectator credentials for receipt-backed truth queries. */
export function ensureV58SpectatorRepoGrantsSchema(sqlite: Database.Database): void {
  ensureV44BroadcastSchema(sqlite);
  if (columnExists(sqlite, 'repo_grants_json')) return;
  try {
    sqlite.exec("ALTER TABLE broadcast_tokens ADD COLUMN repo_grants_json TEXT NOT NULL DEFAULT '[]'");
  } catch (error) {
    if (error instanceof Error && /duplicate column name/i.test(error.message)) return;
    throw error;
  }
}
