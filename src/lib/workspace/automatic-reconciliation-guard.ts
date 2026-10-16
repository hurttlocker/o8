import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { listWorkspaceSnapshotsByPacketId } from '@/lib/worktree/snapshot-state';
import { hasActiveWorkspaceArtifactRestore } from './artifact-restore-state';
import { assertSnapshotRetentionReleased } from './retention-holds';

/** Missing paths and branch refs are intentional while a snapshot owns recovery. */
export function workspaceAllowsAutomaticReconciliation(packetId: string | null): boolean {
  if (!packetId) return true;
  try {
    if (hasActiveWorkspaceArtifactRestore(packetId)) return false;
    const snapshots = listWorkspaceSnapshotsByPacketId(packetId);
    if (snapshots.length > 1) return false;
    for (const snapshot of snapshots) {
      if (snapshot.state !== 'materialized') return false;
      assertSnapshotRetentionReleased(snapshot);
    }
    return true;
  } catch {
    // Corrupt or unreadable lifecycle truth is never absence evidence.
    return false;
  }
}

/** Recheck after collection, then exclude park/restore through terminal writes. */
export async function withAutomaticWorkspaceReconciliation(
  packetId: string | null,
  mutation: () => Promise<boolean>,
): Promise<boolean> {
  if (!packetId) return mutation();
  return withPacketLifecycleMutationLock(packetId, async ({ contended }) => {
    if (contended || !workspaceAllowsAutomaticReconciliation(packetId)) return false;
    return mutation();
  });
}
