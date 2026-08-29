import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureV44BroadcastSchema } from './v44-broadcast-migration';
import { ensureV58SpectatorRepoGrantsSchema } from './v58-spectator-repo-grants-migration';

const openDatabases: Database.Database[] = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe('ensureV58SpectatorRepoGrantsSchema', () => {
  it('adds an empty grant list to existing spectator tokens and is idempotent', () => {
    const sqlite = new Database(':memory:');
    openDatabases.push(sqlite);
    ensureV44BroadcastSchema(sqlite);
    sqlite.prepare(`
      INSERT INTO broadcast_tokens (id, token_hash, label, created_at, revoked_at)
      VALUES (?, ?, ?, ?, NULL)
    `).run('legacy-token', 'a'.repeat(64), 'legacy', '2026-08-29T00:00:00.000Z');

    ensureV58SpectatorRepoGrantsSchema(sqlite);
    ensureV58SpectatorRepoGrantsSchema(sqlite);

    expect(sqlite.prepare(`
      SELECT repo_grants_json FROM broadcast_tokens WHERE id = 'legacy-token'
    `).get()).toEqual({ repo_grants_json: '[]' });
  });
});
