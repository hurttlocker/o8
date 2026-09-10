import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureV61PrMergeEvidenceSchema } from './v61-pr-merge-evidence-migration';

describe('PR merge evidence migration', () => {
  it('adds nullable commit evidence idempotently without inventing proof for old rows', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec('CREATE TABLE github_pull_requests (pull_request_id INTEGER PRIMARY KEY); INSERT INTO github_pull_requests VALUES (1)');
      ensureV61PrMergeEvidenceSchema(sqlite);
      ensureV61PrMergeEvidenceSchema(sqlite);
      expect(sqlite.prepare('SELECT * FROM github_pull_requests').get()).toEqual({ pull_request_id: 1, head_sha: null, merge_commit: null });
    } finally { sqlite.close(); }
  });
});
