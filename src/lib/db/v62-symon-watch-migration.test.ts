import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureV62SymonWatchSchema } from './v62-symon-watch-migration';

describe('Symon watch migration', () => {
  it('adds the standing-intent columns idempotently and leaves old automations untouched', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO automations VALUES ('auto_legacy', 'nightly sweep');
      `);
      ensureV62SymonWatchSchema(sqlite);
      ensureV62SymonWatchSchema(sqlite);
      expect(sqlite.prepare('SELECT * FROM automations').get()).toEqual({
        id: 'auto_legacy',
        name: 'nightly sweep',
        symon_session_id: null,
        symon_then_json: null,
        symon_parked_at: null,
        symon_parked_fire_id: null,
      });
    } finally {
      sqlite.close();
    }
  });
});
