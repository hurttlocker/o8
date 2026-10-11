import type Database from 'better-sqlite3';

export function ensureV67WorkspacePreservationSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspace_retention_holds (
      workspace_path TEXT PRIMARY KEY,
      repository_path TEXT NOT NULL,
      repository_uuid TEXT NOT NULL,
      worktree_id TEXT NOT NULL,
      packet_id TEXT NOT NULL,
      lane_id TEXT NOT NULL,
      hold_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      source_device INTEGER NOT NULL,
      source_inode INTEGER NOT NULL,
      held_at INTEGER NOT NULL,
      released_at INTEGER,
      version INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_retention_holds_identity
      ON workspace_retention_holds(source_device, source_inode, released_at);
    CREATE TABLE IF NOT EXISTS workspace_preservations (
      preservation_id TEXT PRIMARY KEY,
      repository_uuid TEXT NOT NULL,
      repository_path TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      worktree_id TEXT NOT NULL,
      packet_id TEXT,
      lane_id TEXT,
      source_device INTEGER NOT NULL,
      source_inode INTEGER NOT NULL,
      head_commit TEXT NOT NULL,
      tree_sha TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      handoff_sha256 TEXT NOT NULL,
      artifact_count INTEGER NOT NULL,
      artifact_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_preservations_owner
      ON workspace_preservations(repository_path, worktree_id, created_at);
    CREATE TABLE IF NOT EXISTS workspace_artifact_restores (
      restore_id TEXT PRIMARY KEY,
      preservation_id TEXT NOT NULL,
      repository_uuid TEXT NOT NULL,
      target_packet_id TEXT NOT NULL,
      target_lane_id TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      source_device INTEGER NOT NULL,
      source_inode INTEGER NOT NULL,
      selection_sha256 TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('preparing', 'complete')),
      restored_files INTEGER,
      restored_bytes INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_artifact_restore_files (
      restore_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      device INTEGER NOT NULL,
      inode INTEGER NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('prepared', 'complete')),
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY(restore_id, relative_path),
      FOREIGN KEY(restore_id) REFERENCES workspace_artifact_restores(restore_id)
    );
  `);
}
