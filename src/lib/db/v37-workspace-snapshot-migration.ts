import type Database from 'better-sqlite3';

function tableColumnExists(
  sqlite: Database.Database,
  tableName: string,
  columnName: string,
): boolean {
  const rows = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function addColumnTolerant(sqlite: Database.Database, statement: string): void {
  try {
    sqlite.exec(statement);
  } catch (error) {
    if (!String(error).toLowerCase().includes('duplicate column name')) throw error;
  }
}

/**
 * Schema v37 — durable Thin Workspace snapshot truth.
 *
 * The current row is compare-and-set by `record_version`. Transition receipts
 * are immutable so a restart can distinguish a completed state write from an
 * operation that stopped in `hibernating` or `restoring` without guessing from
 * filesystem state.
 */
export function ensureV37WorkspaceSnapshotSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspace_snapshots (
      repository_uuid TEXT NOT NULL,
      packet_id TEXT NOT NULL,
      mission_id TEXT,
      lane_id TEXT,
      original_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      head_commit TEXT NOT NULL,
      tree_sha TEXT NOT NULL,
      recovery_ref TEXT NOT NULL,
      diff_fingerprint TEXT NOT NULL,
      dependency_recipe_key TEXT,
      session_identity_json TEXT NOT NULL DEFAULT '[]',
      reservation_json TEXT,
      snapshot_fingerprint TEXT NOT NULL,
      snapshot_generation INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_generation > 0),
      state TEXT NOT NULL DEFAULT 'materialized'
        CHECK (state IN ('materialized', 'parkable', 'hibernating', 'parked', 'restoring')),
      record_version INTEGER NOT NULL DEFAULT 1 CHECK (record_version > 0),
      last_transition_id TEXT NOT NULL,
      transition_started_at INTEGER NOT NULL,
      state_entered_at INTEGER NOT NULL,
      last_error_json TEXT,
      last_error_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(repository_uuid, packet_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_state_updated
      ON workspace_snapshots(state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_mission
      ON workspace_snapshots(mission_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_lane
      ON workspace_snapshots(lane_id, updated_at);

    CREATE TABLE IF NOT EXISTS workspace_snapshot_transitions (
      repository_uuid TEXT NOT NULL,
      packet_id TEXT NOT NULL,
      transition_id TEXT NOT NULL,
      transition_kind TEXT NOT NULL DEFAULT 'transition'
        CHECK (transition_kind IN ('created', 'transition')),
      from_state TEXT
        CHECK (from_state IS NULL OR from_state IN ('materialized', 'parkable', 'hibernating', 'parked', 'restoring')),
      to_state TEXT NOT NULL
        CHECK (to_state IN ('materialized', 'parkable', 'hibernating', 'parked', 'restoring')),
      prior_version INTEGER NOT NULL CHECK (prior_version >= 0),
      resulting_version INTEGER NOT NULL CHECK (resulting_version > prior_version),
      transition_started_at INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL,
      receipt_json TEXT,
      error_json TEXT,
      snapshot_fingerprint TEXT NOT NULL,
      snapshot_generation INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_generation > 0),
      PRIMARY KEY(repository_uuid, packet_id, transition_id),
      FOREIGN KEY(repository_uuid, packet_id)
        REFERENCES workspace_snapshots(repository_uuid, packet_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_snapshot_transitions_packet_recorded
      ON workspace_snapshot_transitions(repository_uuid, packet_id, recorded_at);

    CREATE TRIGGER IF NOT EXISTS workspace_snapshot_transitions_no_update
    BEFORE UPDATE ON workspace_snapshot_transitions
    BEGIN
      SELECT RAISE(ABORT, 'workspace snapshot transition receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS workspace_snapshot_transitions_no_delete
    BEFORE DELETE ON workspace_snapshot_transitions
    BEGIN
      SELECT RAISE(ABORT, 'workspace snapshot transition receipts are append-only');
    END;
  `);

  if (!tableColumnExists(sqlite, 'workspace_snapshots', 'snapshot_generation')) {
    addColumnTolerant(sqlite, `
      ALTER TABLE workspace_snapshots
      ADD COLUMN snapshot_generation INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_generation > 0)
    `);
  }
  if (!tableColumnExists(sqlite, 'workspace_snapshot_transitions', 'snapshot_generation')) {
    addColumnTolerant(sqlite, `
      ALTER TABLE workspace_snapshot_transitions
      ADD COLUMN snapshot_generation INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_generation > 0)
    `);
  }
}
