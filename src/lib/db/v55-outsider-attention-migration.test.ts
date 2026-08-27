import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ensureV55OutsiderAttentionSchema } from './v55-outsider-attention-migration';

const ATTENTION_COLUMNS = [
  'last_human_comment_author_login',
  'last_human_comment_author_association',
  'last_human_comment_at',
  'last_insider_comment_at',
];

describe('outsider attention migration', () => {
  it('adds nullable attention columns idempotently and leaves existing rows null', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE github_issues (
          issue_id INTEGER PRIMARY KEY,
          repo_full_name TEXT NOT NULL,
          number INTEGER NOT NULL
        );
        CREATE TABLE github_pull_requests (
          pull_request_id INTEGER PRIMARY KEY,
          repo_full_name TEXT NOT NULL,
          number INTEGER NOT NULL
        );
        INSERT INTO github_issues (issue_id, repo_full_name, number)
          VALUES (1, 'example/repo', 11);
        INSERT INTO github_pull_requests (pull_request_id, repo_full_name, number)
          VALUES (2, 'example/repo', 12);
      `);

      ensureV55OutsiderAttentionSchema(sqlite);
      ensureV55OutsiderAttentionSchema(sqlite);

      for (const table of ['github_issues', 'github_pull_requests']) {
        const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
          notnull: number;
          dflt_value: string | null;
        }>;
        for (const columnName of ATTENTION_COLUMNS) {
          expect(columns.find((column) => column.name === columnName)).toMatchObject({
            notnull: 0,
            dflt_value: null,
          });
        }

        const row = sqlite.prepare(`
          SELECT ${ATTENTION_COLUMNS.join(', ')}
          FROM ${table}
          LIMIT 1
        `).get() as Record<string, string | null>;
        expect(row).toEqual(Object.fromEntries(ATTENTION_COLUMNS.map((column) => [column, null])));
      }
    } finally {
      sqlite.close();
    }
  });
});
