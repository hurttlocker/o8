import type Database from 'better-sqlite3';

const SNAPSHOT_STATES = "'materialized', 'parkable', 'hibernating', 'parked', 'restoring', 'retiring', 'retired'";

function retirementStatesArePresent(sqlite: Database.Database): boolean {
  const row = sqlite.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_snapshots'
  `).get() as { sql?: string } | undefined;
  return row?.sql?.includes("'retired'") === true;
}

/** Schema v41: persist terminal materialization retirement without losing receipt history. */
export function ensureV41WorkspaceRetirementSchema(
  sqlite: Database.Database,
  hooks: { beforeMigrationLock?: () => void; afterMigrationLock?: () => void } = {},
): void {
  if (retirementStatesArePresent(sqlite)) return;
  const foreignKeysEnabled = Number(sqlite.pragma('foreign_keys', { simple: true })) === 1;
  if (foreignKeysEnabled) sqlite.pragma('foreign_keys = OFF');
  try {
    hooks.beforeMigrationLock?.();
    sqlite.transaction(() => {
      if (retirementStatesArePresent(sqlite)) return;
      hooks.afterMigrationLock?.();
      sqlite.exec(`
        DROP TRIGGER IF EXISTS workspace_snapshot_transitions_no_update;
        DROP TRIGGER IF EXISTS workspace_snapshot_transitions_no_delete;

        CREATE TABLE workspace_snapshots_v41 (
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
          state TEXT NOT NULL DEFAULT 'materialized' CHECK (state IN (${SNAPSHOT_STATES})),
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

        CREATE TABLE workspace_snapshot_transitions_v41 (
          repository_uuid TEXT NOT NULL,
          packet_id TEXT NOT NULL,
          transition_id TEXT NOT NULL,
          transition_kind TEXT NOT NULL DEFAULT 'transition'
            CHECK (transition_kind IN ('created', 'transition')),
          from_state TEXT CHECK (from_state IS NULL OR from_state IN (${SNAPSHOT_STATES})),
          to_state TEXT NOT NULL CHECK (to_state IN (${SNAPSHOT_STATES})),
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
            REFERENCES workspace_snapshots_v41(repository_uuid, packet_id) ON DELETE CASCADE
        );

        INSERT INTO workspace_snapshots_v41 SELECT * FROM workspace_snapshots;
        INSERT INTO workspace_snapshot_transitions_v41 SELECT * FROM workspace_snapshot_transitions;
        DROP TABLE workspace_snapshot_transitions;
        DROP TABLE workspace_snapshots;
        ALTER TABLE workspace_snapshots_v41 RENAME TO workspace_snapshots;
        ALTER TABLE workspace_snapshot_transitions_v41 RENAME TO workspace_snapshot_transitions;

        CREATE INDEX idx_workspace_snapshots_state_updated
          ON workspace_snapshots(state, updated_at);
        CREATE INDEX idx_workspace_snapshots_mission
          ON workspace_snapshots(mission_id, updated_at);
        CREATE INDEX idx_workspace_snapshots_lane
          ON workspace_snapshots(lane_id, updated_at);
        CREATE INDEX idx_workspace_snapshot_transitions_packet_recorded
          ON workspace_snapshot_transitions(repository_uuid, packet_id, recorded_at);

        CREATE TRIGGER workspace_snapshot_transitions_no_update
        BEFORE UPDATE ON workspace_snapshot_transitions
        BEGIN
          SELECT RAISE(ABORT, 'workspace snapshot transition receipts are immutable');
        END;
        CREATE TRIGGER workspace_snapshot_transitions_no_delete
        BEFORE DELETE ON workspace_snapshot_transitions
        BEGIN
          SELECT RAISE(ABORT, 'workspace snapshot transition receipts are append-only');
        END;
      `);
    }).immediate();
  } finally {
    if (foreignKeysEnabled) sqlite.pragma('foreign_keys = ON');
  }
}
