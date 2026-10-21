import path from 'node:path';

import { getSqlite } from '@/lib/db';

/** Pending publication remains exclusive after the lifecycle lease's process dies. */
export function hasActiveWorkspaceArtifactRestore(packetId: string, workspacePath?: string): boolean {
  return Boolean(getSqlite().prepare(`
    SELECT restore_id FROM workspace_artifact_restores
    WHERE state = 'preparing' AND (target_packet_id = ? OR workspace_path = ?)
    LIMIT 1
  `).get(packetId, workspacePath ? path.resolve(workspacePath) : null));
}

export function assertNoActiveWorkspaceArtifactRestore(packetId: string, workspacePath?: string): void {
  if (hasActiveWorkspaceArtifactRestore(packetId, workspacePath)) {
    throw new Error('Artifact recovery is incomplete; resume its exact restore receipt before changing this workspace.');
  }
}
