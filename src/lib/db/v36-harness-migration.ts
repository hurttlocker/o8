import type Database from 'better-sqlite3';

/**
 * Schema v36 (#1204) — durable, repo-scoped harness artifacts.
 *
 * The tables are additive and every statement is idempotent because the
 * desktop server, websocket server, and standalone MCP process can all open
 * the same database during an upgrade.
 */
export function ensureV36HarnessSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS harness_features (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 100,
      status TEXT NOT NULL DEFAULT 'failing'
        CHECK (status IN ('failing', 'passing', 'blocked')),
      verification_command_json TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_harness_features_repo_status_priority
      ON harness_features(repo_path, status, priority, created_at);

    CREATE TABLE IF NOT EXISTS harness_feature_checks (
      id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL REFERENCES harness_features(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'skipped')),
      evidence TEXT NOT NULL DEFAULT '',
      command_json TEXT,
      exit_code INTEGER,
      model_id TEXT,
      packet_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_harness_feature_checks_feature_created
      ON harness_feature_checks(feature_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS harness_groundings (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      task TEXT NOT NULL,
      feature_id TEXT REFERENCES harness_features(id) ON DELETE SET NULL,
      packet_id TEXT,
      artifact_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_harness_groundings_repo_created
      ON harness_groundings(repo_path, created_at DESC);

    CREATE TABLE IF NOT EXISTS harness_contracts (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      feature_id TEXT REFERENCES harness_features(id) ON DELETE SET NULL,
      grounding_id TEXT REFERENCES harness_groundings(id) ON DELETE SET NULL,
      generator_terms TEXT NOT NULL,
      evaluator_terms TEXT NOT NULL,
      acceptance_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'accepted', 'verified', 'failed', 'superseded')),
      proposed_by TEXT,
      accepted_by TEXT,
      created_at INTEGER NOT NULL,
      accepted_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_harness_contracts_repo_created
      ON harness_contracts(repo_path, created_at DESC);

    CREATE TABLE IF NOT EXISTS harness_sprints (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      contract_id TEXT NOT NULL REFERENCES harness_contracts(id) ON DELETE CASCADE,
      packet_id TEXT,
      current_feature_id TEXT REFERENCES harness_features(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'blocked', 'completed')),
      tick_count INTEGER NOT NULL DEFAULT 0,
      event_log_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_harness_sprints_repo_status
      ON harness_sprints(repo_path, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS harness_components (
      component_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      lifecycle TEXT NOT NULL DEFAULT 'retained'
        CHECK (lifecycle IN ('retained', 'candidate', 'shadow_only', 'retired')),
      reason TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(component_key, model_id)
    );

    CREATE TABLE IF NOT EXISTS harness_measurements (
      id TEXT PRIMARY KEY,
      component_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      baseline_score REAL NOT NULL,
      enabled_score REAL NOT NULL,
      lift REAL NOT NULL,
      sample_count INTEGER NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      FOREIGN KEY(component_key, model_id)
        REFERENCES harness_components(component_key, model_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_harness_measurements_component_model_created
      ON harness_measurements(component_key, model_id, created_at DESC);
  `);
}
