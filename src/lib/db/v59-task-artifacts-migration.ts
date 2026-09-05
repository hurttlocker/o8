import type Database from 'better-sqlite3';

/**
 * Schema v59 (#1699): interactive task artifacts and their action receipts.
 *
 * `task_artifacts` holds the agent-authored document, its declared actions,
 * and the explicit target identity it may return to. `task_artifact_actions`
 * is the append-only receipt ledger: every submission the server saw, accepted
 * or rejected, with its payload hash, target, actor, and delivery result.
 * A nonce may be accepted once per artifact; rejected rows keep their nonce for
 * the audit trail without blocking a later legitimate submission.
 */
export function ensureV59TaskArtifactsSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_artifacts (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      title TEXT NOT NULL,
      html TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      thread_id TEXT,
      packet_id TEXT,
      lane_id TEXT,
      session_key TEXT,
      origin_head TEXT,
      head_policy TEXT NOT NULL DEFAULT 'pinned',
      actions_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'live',
      state_reason TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_artifacts_thread ON task_artifacts(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_artifacts_packet ON task_artifacts(packet_id, created_at);

    CREATE TABLE IF NOT EXISTS task_artifact_actions (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      action TEXT NOT NULL,
      nonce TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      target_json TEXT NOT NULL,
      actor TEXT NOT NULL,
      delivery TEXT NOT NULL,
      delivery_note TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_artifact_actions_artifact ON task_artifact_actions(artifact_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_artifact_actions_nonce
      ON task_artifact_actions(artifact_id, nonce) WHERE delivery <> 'rejected';
  `);
}
