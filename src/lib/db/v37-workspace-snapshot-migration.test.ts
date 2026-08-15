import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ensureV37WorkspaceSnapshotSchema } from './v37-workspace-snapshot-migration';

describe('v37 workspace snapshot additive upgrade', () => {
  it('backfills generation one on snapshot tables created before generations shipped', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workspace_snapshots (
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
        state TEXT NOT NULL,
        record_version INTEGER NOT NULL,
        last_transition_id TEXT NOT NULL,
        transition_started_at INTEGER NOT NULL,
        state_entered_at INTEGER NOT NULL,
        last_error_json TEXT,
        last_error_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(repository_uuid, packet_id)
      );
      CREATE TABLE workspace_snapshot_transitions (
        repository_uuid TEXT NOT NULL,
        packet_id TEXT NOT NULL,
        transition_id TEXT NOT NULL,
        transition_kind TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        prior_version INTEGER NOT NULL,
        resulting_version INTEGER NOT NULL,
        transition_started_at INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        receipt_json TEXT,
        error_json TEXT,
        snapshot_fingerprint TEXT NOT NULL,
        PRIMARY KEY(repository_uuid, packet_id, transition_id)
      );
      INSERT INTO workspace_snapshots VALUES (
        'repo', 'packet', NULL, 'lane', '/tmp/packet', 'inline/packet',
        'base', 'head', 'tree', 'refs/o8/recovery/repo/packet', 'diff',
        NULL, '[]', NULL, 'fingerprint', 'materialized', 1, 'create',
        1, 1, NULL, NULL, 1, 1
      );
      INSERT INTO workspace_snapshot_transitions VALUES (
        'repo', 'packet', 'create', 'created', NULL, 'materialized',
        0, 1, 1, 1, NULL, NULL, 'fingerprint'
      );
    `);

    ensureV37WorkspaceSnapshotSchema(sqlite);
    ensureV37WorkspaceSnapshotSchema(sqlite);

    expect(sqlite.prepare(`
      SELECT snapshot_generation FROM workspace_snapshots
      WHERE repository_uuid = 'repo' AND packet_id = 'packet'
    `).pluck().get()).toBe(1);
    expect(sqlite.prepare(`
      SELECT snapshot_generation FROM workspace_snapshot_transitions
      WHERE repository_uuid = 'repo' AND packet_id = 'packet'
    `).pluck().get()).toBe(1);
    sqlite.close();
  });
});
