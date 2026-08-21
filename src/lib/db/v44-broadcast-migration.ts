import type Database from 'better-sqlite3';

/** Schema v44: durable hashed credentials for the read-only Broadcast surface. */
export function ensureV44BroadcastSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS broadcast_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
      label TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_broadcast_tokens_active
      ON broadcast_tokens(revoked_at, created_at);
  `);
}
