import type Database from 'better-sqlite3';

import { ensureV44BroadcastSchema } from './v44-broadcast-migration';

interface TableSqlRow {
  sql: string | null;
}

function supportsFocus(sqlite: Database.Database): boolean {
  const row = sqlite.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'broadcast_events'
  `).get() as TableSqlRow | undefined;
  return row?.sql?.includes("'focus'") ?? false;
}

/** Schema v45: expand durable Broadcast events with the operator focus kind. */
export function ensureV45BroadcastFocusSchema(sqlite: Database.Database): void {
  ensureV44BroadcastSchema(sqlite);
  if (supportsFocus(sqlite)) return;

  sqlite.transaction(() => {
    if (supportsFocus(sqlite)) return;
    sqlite.exec(`
      CREATE TABLE broadcast_events_v45 (
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

      INSERT INTO broadcast_events_v45
        (sequence, id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at)
      SELECT sequence, id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at
      FROM broadcast_events;

      DROP TABLE broadcast_events;
      ALTER TABLE broadcast_events_v45 RENAME TO broadcast_events;

      CREATE INDEX idx_broadcast_events_kind_created
        ON broadcast_events(kind, created_at);
    `);
  })();
}
