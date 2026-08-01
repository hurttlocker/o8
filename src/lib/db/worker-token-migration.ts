import type Database from 'better-sqlite3';

export function ensureWorkerTokenStorage(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS worker_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      packet_id TEXT,
      label TEXT,
      scope TEXT NOT NULL,
      max_workers INTEGER NOT NULL DEFAULT 10,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    )
  `);

  const columns = sqlite.pragma('table_info(worker_tokens)') as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'packet_id')) {
    sqlite.exec('ALTER TABLE worker_tokens ADD COLUMN packet_id TEXT');
  }
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_worker_tokens_packet_id ON worker_tokens(packet_id)');
}
