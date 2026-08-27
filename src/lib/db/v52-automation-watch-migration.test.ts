import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ensureV51AutomationPrecheckSchema } from './v51-automation-precheck-migration';
import { ensureV52AutomationWatchSchema } from './v52-automation-watch-migration';

function columnNames(sqlite: Database.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
}

describe('automation precheck and watch migrations', () => {
  it('upgrades the existing automation tables idempotently without rebuilding history', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE automations (id TEXT PRIMARY KEY);
        CREATE TABLE automation_fires (id TEXT PRIMARY KEY);
        INSERT INTO automations (id) VALUES ('existing-automation');
        INSERT INTO automation_fires (id) VALUES ('existing-fire');
      `);

      ensureV51AutomationPrecheckSchema(sqlite);
      ensureV52AutomationWatchSchema(sqlite);
      ensureV51AutomationPrecheckSchema(sqlite);
      ensureV52AutomationWatchSchema(sqlite);

      expect(columnNames(sqlite, 'automations')).toEqual(expect.arrayContaining([
        'precheck_command',
        'precheck_timeout_ms',
        'watch_source_kind',
        'watch_checkpoint',
        'watch_batch_window_ms',
      ]));
      expect(columnNames(sqlite, 'automation_fires')).toEqual(expect.arrayContaining([
        'precheck_status',
        'source_event_id',
        'source_fingerprint',
        'action_kind',
      ]));
      expect(sqlite.prepare('SELECT id FROM automations').all()).toEqual([{ id: 'existing-automation' }]);
      expect(sqlite.prepare('SELECT id FROM automation_fires').all()).toEqual([{ id: 'existing-fire' }]);
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automation_source_events'").get())
        .toEqual({ name: 'automation_source_events' });
    } finally {
      sqlite.close();
    }
  });
});
