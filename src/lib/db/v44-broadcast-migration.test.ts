import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureV44BroadcastSchema } from './v44-broadcast-migration';

const openDatabases: Database.Database[] = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe('v44 Broadcast migration', () => {
  it('is additive, repeatable, and constrains credentials and feed text', () => {
    const sqlite = new Database(':memory:');
    openDatabases.push(sqlite);
    sqlite.exec('CREATE TABLE legacy_state (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO legacy_state VALUES (\'live\', \'untouched\');');

    ensureV44BroadcastSchema(sqlite);
    ensureV44BroadcastSchema(sqlite);

    sqlite.prepare(`
      INSERT INTO broadcast_tokens (id, token_hash, label, created_at, revoked_at)
      VALUES (?, ?, ?, ?, NULL)
    `).run('spectator-one', 'a'.repeat(64), 'OBS', new Date().toISOString());
    expect(sqlite.prepare('SELECT value FROM legacy_state WHERE id = \'live\'').get())
      .toEqual({ value: 'untouched' });
    expect(() => sqlite.prepare(`
      INSERT INTO broadcast_tokens (id, token_hash, created_at)
      VALUES ('bad', 'plaintext', 'now')
    `).run()).toThrow();
    sqlite.prepare(`
      INSERT INTO broadcast_events (id, kind, actor, text, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('broadcast-one', 'commentary', 'mister', 'A bounded line.', new Date().toISOString());
    expect(sqlite.prepare('SELECT kind, actor, text FROM broadcast_events').get()).toEqual({
      kind: 'commentary',
      actor: 'mister',
      text: 'A bounded line.',
    });
    expect(() => sqlite.prepare(`
      INSERT INTO broadcast_events (id, kind, actor, text, created_at)
      VALUES ('broadcast-too-long', 'commentary', 'mister', ?, 'now')
    `).run('x'.repeat(2_001))).toThrow();
  });
});
