import type Database from 'better-sqlite3';

/** Schema v44: durable credentials plus additive lane-less Broadcast events. */
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

    CREATE TABLE IF NOT EXISTS broadcast_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('commentary', 'conversation', 'focus')),
      actor TEXT NOT NULL,
      audience TEXT,
      text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
      lane_id TEXT,
      packet_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_broadcast_events_kind_created
      ON broadcast_events(kind, created_at);
  `);
}
