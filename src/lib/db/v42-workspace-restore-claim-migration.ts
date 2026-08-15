import type Database from 'better-sqlite3';

/** Schema v42: trusted exact-inode authority for crash-safe filesystem claims. */
export function ensureV42WorkspaceRestoreClaimSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspace_exact_claims (
      kind TEXT NOT NULL CHECK (kind IN ('restore-creation', 'worktree-quarantine', 'managed-retirement')),
      repository_path TEXT NOT NULL,
      worktree_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      expected_path TEXT NOT NULL,
      source_path TEXT NOT NULL,
      claim_path TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'claimed', 'published', 'purging')),
      parent_device INTEGER NOT NULL,
      parent_inode INTEGER NOT NULL,
      parent_canonical_path TEXT NOT NULL,
      source_device INTEGER,
      source_inode INTEGER,
      claim_device INTEGER,
      claim_inode INTEGER,
      content_digest TEXT,
      authority_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(kind, repository_path, worktree_id),
      UNIQUE(kind, operation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_exact_claims_kind_state
      ON workspace_exact_claims(kind, state, updated_at);
  `);
}
