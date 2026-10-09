import type Database from 'better-sqlite3';

/** Child output uses the existing exact-claim journal, with its own authority. */
export function ensureV69GeneratedOutputSchema(sqlite: Database.Database): void {
  sqlite.transaction(() => {
    const schema = sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'workspace_exact_claims'")
      .get() as { sql: string };
    if (!schema.sql.includes("'generated-output-recovery-retirement'")) {
      const indexes = sqlite.prepare(`SELECT sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'workspace_exact_claims' AND sql IS NOT NULL`)
        .all() as Array<{ sql: string }>;
      sqlite.exec(`
        ALTER TABLE workspace_exact_claims RENAME TO workspace_exact_claims_v69_prior;
        CREATE TABLE workspace_exact_claims (
          kind TEXT NOT NULL CHECK (kind IN (
            'restore-creation', 'worktree-quarantine', 'managed-retirement', 'generated-output-retirement',
            'generated-output-recovery-retirement'
          )),
          repository_path TEXT NOT NULL, worktree_id TEXT NOT NULL,
          operation_id TEXT NOT NULL, expected_path TEXT NOT NULL,
          source_path TEXT NOT NULL, claim_path TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('prepared', 'claimed', 'published', 'purging')),
          parent_device INTEGER NOT NULL, parent_inode INTEGER NOT NULL,
          parent_canonical_path TEXT NOT NULL,
          source_device INTEGER, source_inode INTEGER, claim_device INTEGER, claim_inode INTEGER,
          content_digest TEXT, authority_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(kind, repository_path, worktree_id), UNIQUE(kind, operation_id)
        );
        INSERT INTO workspace_exact_claims SELECT * FROM workspace_exact_claims_v69_prior;
        DROP TABLE workspace_exact_claims_v69_prior;
      `);
      for (const index of indexes) sqlite.exec(index.sql);
    }
    const finalizations = sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'workspace_exact_finalizations'")
      .get() as { sql: string };
    if (!finalizations.sql.includes("'generated-output-recovery-retirement'")) {
      const indexes = sqlite.prepare(`SELECT sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'workspace_exact_finalizations' AND sql IS NOT NULL`)
        .all() as Array<{ sql: string }>;
      sqlite.exec(`
        ALTER TABLE workspace_exact_finalizations RENAME TO workspace_exact_finalizations_v69_prior;
        CREATE TABLE workspace_exact_finalizations (
          operation_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('managed-retirement', 'generated-output-retirement', 'generated-output-recovery-retirement')),
          repository_path TEXT NOT NULL, worktree_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('admitted', 'complete')),
          receipt_json TEXT NOT NULL, admitted_at INTEGER NOT NULL, completed_at INTEGER,
          CHECK((state = 'admitted' AND completed_at IS NULL)
            OR (state = 'complete' AND completed_at IS NOT NULL))
        );
        INSERT INTO workspace_exact_finalizations SELECT * FROM workspace_exact_finalizations_v69_prior;
        DROP TABLE workspace_exact_finalizations_v69_prior;
      `);
      for (const index of indexes) sqlite.exec(index.sql);
    }
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS workspace_generated_outputs (
        resource_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'planned', 'legacy-held', 'ready', 'active', 'succeeded', 'failed-held', 'adopted', 'retired'
        )),
        payload_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_output_current
        ON workspace_generated_outputs(workspace_path) WHERE state != 'retired';
      CREATE INDEX IF NOT EXISTS idx_generated_output_state
        ON workspace_generated_outputs(state, updated_at, resource_id);
      CREATE TABLE IF NOT EXISTS workspace_generated_output_recoveries (
        resource_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose IN ('recovery', 'verification-disposable')),
        state TEXT NOT NULL CHECK(state IN ('planned', 'restoring', 'complete', 'failed-held', 'retired')),
        payload_json TEXT NOT NULL,
        PRIMARY KEY(resource_id, operation_id)
      );
      CREATE TABLE IF NOT EXISTS workspace_generated_output_recovery_entries (
        resource_id TEXT NOT NULL, operation_id TEXT NOT NULL, relative TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('file', 'directory')),
        device INTEGER, inode INTEGER, canonical_path TEXT,
        phase TEXT NOT NULL CHECK(phase IN ('planned', 'ready', 'prepared', 'written', 'complete')),
        receipt_json TEXT,
        observed_closed INTEGER NOT NULL CHECK(observed_closed IN (0, 1)),
        exit_code INTEGER,
        PRIMARY KEY(resource_id, operation_id, relative),
        CHECK((phase = 'complete' AND observed_closed = 1 AND exit_code = 0)
          OR (phase != 'complete' AND observed_closed = 0 AND exit_code IS NULL))
      );
      CREATE TABLE IF NOT EXISTS workspace_generated_output_bank_entries (
        resource_id TEXT NOT NULL, capture_id TEXT NOT NULL,
        entry_index INTEGER NOT NULL CHECK(entry_index >= -1 AND entry_index < 20000),
        entry_json TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('planned', 'ready', 'prepared', 'written', 'complete')),
        receipt_json TEXT,
        observed_closed INTEGER NOT NULL CHECK(observed_closed IN (0, 1)),
        exit_code INTEGER,
        PRIMARY KEY(resource_id, capture_id, entry_index),
        CHECK((phase = 'complete' AND observed_closed = 1 AND exit_code = 0)
          OR (phase != 'complete' AND observed_closed = 0 AND exit_code IS NULL))
      );
    `);
  }).immediate();
}
