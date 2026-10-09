import path from 'node:path';

import { getSqlite } from '@/lib/db';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';

export interface WorkspaceRetentionHold {
  workspacePath: string;
  repositoryPath: string;
  repositoryUuid: string;
  worktreeId: string;
  packetId: string;
  laneId: string;
  holdId: string;
  reason: string;
  sourceDevice: number;
  sourceInode: number;
  heldAt: number;
  releasedAt: number | null;
  version: number;
}

interface HoldRow {
  workspace_path: string;
  repository_path: string;
  repository_uuid: string;
  worktree_id: string;
  packet_id: string;
  lane_id: string;
  hold_id: string;
  reason: string;
  source_device: number;
  source_inode: number;
  held_at: number;
  released_at: number | null;
  version: number;
}

function decode(row: HoldRow): WorkspaceRetentionHold {
  return {
    workspacePath: row.workspace_path,
    repositoryPath: row.repository_path,
    repositoryUuid: row.repository_uuid,
    worktreeId: row.worktree_id,
    packetId: row.packet_id,
    laneId: row.lane_id,
    holdId: row.hold_id,
    reason: row.reason,
    sourceDevice: row.source_device,
    sourceInode: row.source_inode,
    heldAt: row.held_at,
    releasedAt: row.released_at,
    version: row.version,
  };
}

export function getWorkspaceRetentionHold(
  workspacePath: string,
  identity?: Pick<WorktreeMaterializationIdentity, 'device' | 'inode'>,
): WorkspaceRetentionHold | null {
  const row = getSqlite().prepare(`
    SELECT * FROM workspace_retention_holds
    WHERE released_at IS NULL AND (
      workspace_path = ? OR (source_device = ? AND source_inode = ?)
    ) ORDER BY held_at ASC LIMIT 1
  `).get(path.resolve(workspacePath), identity?.device ?? -1, identity?.inode ?? -1) as HoldRow | undefined;
  return row ? decode(row) : null;
}

export function assertWorkspaceRetentionReleased(
  workspacePath: string,
  identity?: Pick<WorktreeMaterializationIdentity, 'device' | 'inode'>,
): void {
  if (getWorkspaceRetentionHold(workspacePath, identity)) {
    throw new Error('Workspace retirement is blocked by a persisted retention hold.');
  }
}

export function assertSnapshotRetentionReleased(input: {
  repositoryUuid: string;
  packetId: string;
  originalPath: string;
}): void {
  const held = getSqlite().prepare(`
    SELECT hold_id FROM workspace_retention_holds WHERE released_at IS NULL
      AND (workspace_path = ? OR (repository_uuid = ? AND packet_id = ?)) LIMIT 1
  `).get(path.resolve(input.originalPath), input.repositoryUuid, input.packetId);
  if (held) throw new Error('Workspace retirement is blocked by a persisted retention hold.');
}

/** Hold admission serializes with retirement claim creation, independently of process leases. */
export function acquireWorkspaceRetentionHold(input: {
  repositoryPath: string;
  repositoryUuid: string;
  worktreeId: string;
  packetId: string;
  laneId: string;
  identity: WorktreeMaterializationIdentity;
  holdId: string;
  reason: string;
}): WorkspaceRetentionHold {
  const sqlite = getSqlite();
  return sqlite.transaction(() => {
    const workspacePath = input.identity.canonicalPath;
    const active = getWorkspaceRetentionHold(workspacePath, input.identity);
    if (active) {
      if (active.workspacePath === workspacePath && active.holdId === input.holdId
        && active.reason === input.reason && active.packetId === input.packetId
        && active.laneId === input.laneId) return active;
      throw new Error('The workspace already has a different retention hold.');
    }
    const claim = sqlite.prepare(`
      SELECT operation_id FROM workspace_exact_claims
      WHERE kind IN ('managed-retirement', 'generated-output-retirement', 'generated-output-recovery-retirement') AND (
        expected_path = ? OR (source_device = ? AND source_inode = ?)
        OR (kind = 'generated-output-retirement' AND (
          parent_canonical_path = ? OR (parent_device = ? AND parent_inode = ?)
        ))
      ) LIMIT 1
    `).get(workspacePath, input.identity.device, input.identity.inode,
      workspacePath, input.identity.device, input.identity.inode);
    const retiring = sqlite.prepare(`
      SELECT packet_id FROM workspace_snapshots
      WHERE (original_path = ? OR (repository_uuid = ? AND packet_id = ?))
        AND state IN ('parkable', 'hibernating', 'restoring', 'retiring', 'retired') LIMIT 1
    `).get(workspacePath, input.repositoryUuid, input.packetId);
    if (claim || retiring) {
      throw new Error('Workspace retirement or materialization change already began; a new hold was not granted.');
    }
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO workspace_retention_holds (
        workspace_path, repository_path, repository_uuid, worktree_id, packet_id,
        lane_id, hold_id, reason, source_device, source_inode, held_at, released_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
      ON CONFLICT(workspace_path) DO UPDATE SET
        repository_path = excluded.repository_path, repository_uuid = excluded.repository_uuid,
        worktree_id = excluded.worktree_id, packet_id = excluded.packet_id, lane_id = excluded.lane_id,
        hold_id = excluded.hold_id, reason = excluded.reason, source_device = excluded.source_device,
        source_inode = excluded.source_inode, held_at = excluded.held_at, released_at = NULL,
        version = workspace_retention_holds.version + 1
      WHERE workspace_retention_holds.released_at IS NOT NULL
    `).run(
      workspacePath, path.resolve(input.repositoryPath), input.repositoryUuid,
      input.worktreeId, input.packetId, input.laneId, input.holdId, input.reason,
      input.identity.device, input.identity.inode, now,
    );
    const result = getWorkspaceRetentionHold(workspacePath, input.identity);
    if (!result || result.holdId !== input.holdId) throw new Error('Workspace hold lost its durable admission.');
    return result;
  }).immediate();
}

export function releaseWorkspaceRetentionHold(input: {
  repositoryUuid: string;
  packetId: string;
  holdId: string;
}): WorkspaceRetentionHold {
  const sqlite = getSqlite();
  return sqlite.transaction(() => {
    const row = sqlite.prepare(`
      SELECT * FROM workspace_retention_holds
      WHERE repository_uuid = ? AND packet_id = ? AND hold_id = ?
    `).get(input.repositoryUuid, input.packetId, input.holdId) as HoldRow | undefined;
    if (!row) throw new Error('The requested retention hold was not found; no hold was released.');
    if (row.released_at === null) {
      sqlite.prepare(`
        UPDATE workspace_retention_holds SET released_at = ?, version = version + 1
        WHERE workspace_path = ? AND hold_id = ? AND released_at IS NULL AND version = ?
      `).run(Date.now(), row.workspace_path, input.holdId, row.version);
    }
    const result = sqlite.prepare(`
      SELECT * FROM workspace_retention_holds WHERE workspace_path = ? AND hold_id = ?
    `).get(row.workspace_path, input.holdId) as HoldRow | undefined;
    if (!result || result.released_at === null) throw new Error('Workspace hold release lost its compare-and-swap.');
    return decode(result);
  }).immediate();
}
