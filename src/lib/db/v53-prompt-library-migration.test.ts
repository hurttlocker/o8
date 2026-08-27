import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ensureV53PromptLibrarySchema } from './v53-prompt-library-migration';

describe('prompt library migration', () => {
  it('creates the curated prompt ledger idempotently with scoped duplicate guards', () => {
    const sqlite = new Database(':memory:');
    try {
      ensureV53PromptLibrarySchema(sqlite);
      ensureV53PromptLibrarySchema(sqlite);

      const columns = (sqlite.prepare('PRAGMA table_info(prompt_library)').all() as Array<{ name: string }>)
        .map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining([
        'id',
        'title',
        'body',
        'body_fingerprint',
        'tags_json',
        'scope',
        'repo_path',
        'last_used_at',
        'use_count',
      ]));

      const insert = sqlite.prepare(`
        INSERT INTO prompt_library (
          id, title, body, body_fingerprint, scope, repo_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run('global-1', 'Security review', 'Review this', 'same-body', 'global', null, 1, 1);
      expect(() => insert.run(
        'global-2', 'Duplicate', 'Review this', 'same-body', 'global', null, 2, 2,
      )).toThrow(/UNIQUE constraint failed/);

      insert.run('repo-1', 'Repo review', 'Review this', 'same-body', 'repo', '/repo/one', 3, 3);
      insert.run('repo-2', 'Other repo review', 'Review this', 'same-body', 'repo', '/repo/two', 4, 4);
      expect(() => insert.run(
        'repo-3', 'Duplicate repo review', 'Review this', 'same-body', 'repo', '/repo/one', 5, 5,
      )).toThrow(/UNIQUE constraint failed/);
    } finally {
      sqlite.close();
    }
  });
});
