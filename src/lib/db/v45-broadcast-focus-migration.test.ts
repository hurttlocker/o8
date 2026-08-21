import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureV45BroadcastFocusSchema } from './v45-broadcast-focus-migration';

const openDatabases: Database.Database[] = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe('v45 Broadcast focus migration', () => {
  it('preserves existing events and admits focus events repeatably', () => {
    const sqlite = new Database(':memory:');
    openDatabases.push(sqlite);
    sqlite.exec(`
      CREATE TABLE broadcast_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('commentary', 'conversation')),
        actor TEXT NOT NULL,
        audience TEXT,
        text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
        lane_id TEXT,
        packet_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO broadcast_events (id, kind, actor, text, created_at)
      VALUES ('existing', 'commentary', 'operator', 'Still here.', '2026-08-21T00:00:00.000Z');
    `);

    ensureV45BroadcastFocusSchema(sqlite);
    ensureV45BroadcastFocusSchema(sqlite);
    sqlite.prepare(`
      INSERT INTO broadcast_events (id, kind, actor, text, metadata_json, created_at)
      VALUES ('focus-one', 'focus', 'operator', 'Ship focus', '{}', '2026-08-21T00:01:00.000Z')
    `).run();

    expect(sqlite.prepare('SELECT id, kind FROM broadcast_events ORDER BY sequence').all()).toEqual([
      { id: 'existing', kind: 'commentary' },
      { id: 'focus-one', kind: 'focus' },
    ]);
  });
});
