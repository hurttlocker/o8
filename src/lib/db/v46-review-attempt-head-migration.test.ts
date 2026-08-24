import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureV46ReviewAttemptHeadSchema } from './v46-review-attempt-head-migration';

const openDatabases: Database.Database[] = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe('v46 review attempt migration', () => {
  it('preserves a legacy failed-busy row and adds durable claim fields repeatably', () => {
    const sqlite = new Database(':memory:');
    openDatabases.push(sqlite);
    sqlite.exec(`
      CREATE TABLE review_queue (
        id TEXT PRIMARY KEY,
        lane_id TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO review_queue (
        id, lane_id, repo_path, status, attempts, last_error
      ) VALUES (
        'review-legacy-busy', 'lane-legacy', '/repo', 'failed', 5,
        'Review turn failed: reviewer session busy'
      );
    `);

    ensureV46ReviewAttemptHeadSchema(sqlite);
    ensureV46ReviewAttemptHeadSchema(sqlite);

    expect(sqlite.prepare(`
      SELECT id, status, attempts, last_error, head_sha, claimed_at, claim_owner
      FROM review_queue WHERE id = 'review-legacy-busy'
    `).get()).toEqual({
      id: 'review-legacy-busy',
      status: 'failed',
      attempts: 5,
      last_error: 'Review turn failed: reviewer session busy',
      head_sha: null,
      claimed_at: null,
      claim_owner: null,
    });
    expect((sqlite.pragma('index_list(review_queue)') as Array<{ name: string }>).map((row) => row.name))
      .toContain('idx_review_queue_lane_status');
  });
});
