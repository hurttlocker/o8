import type Database from 'better-sqlite3';

export function ensureV68ExactFinalizationSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspace_exact_finalizations (
      operation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind = 'managed-retirement'),
      repository_path TEXT NOT NULL,
      worktree_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('admitted', 'complete')),
      receipt_json TEXT NOT NULL,
      admitted_at INTEGER NOT NULL,
      completed_at INTEGER,
      CHECK((state = 'admitted' AND completed_at IS NULL)
        OR (state = 'complete' AND completed_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_exact_finalizations_owner
      ON workspace_exact_finalizations(repository_path, worktree_id, admitted_at);
  `);
}
