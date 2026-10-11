import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

import type { Lane } from '@/lib/lane/types';
import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import { listWorkspaceSnapshotsByPacketId } from '@/lib/worktree/snapshot-state';
import { withWorktreeMaterializationExecution } from '@/lib/worktree/materialization-execution';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { assertManagedWorkspaceMaterialization } from './managed-materialization-identity';
import { assertNoActiveWorkspaceArtifactRestore } from './artifact-restore-state';

export type WorkspaceMutationUnavailableCode =
  | 'workspace_restore_required'
  | 'workspace_state_unknown';

export class WorkspaceMutationUnavailableError extends Error {
  constructor(
    readonly code: WorkspaceMutationUnavailableCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceMutationUnavailableError';
  }
}

interface MutationAuthority { active: boolean }
const heldMutationPackets = new AsyncLocalStorage<ReadonlyMap<string, MutationAuthority>>();

/** Durable, filesystem-free precondition for any write through a packet workspace. */
export async function assertWorkspaceMaterializedForMutation(
  lane: Lane,
): Promise<WorktreeMaterializationIdentity | null> {
  const packetId = lane.packetId?.trim();
  if (!packetId) return null;
  let snapshots;
  try {
    assertNoActiveWorkspaceArtifactRestore(packetId, lane.worktreePath ?? undefined);
    snapshots = listWorkspaceSnapshotsByPacketId(packetId);
  } catch {
    throw new WorkspaceMutationUnavailableError(
      'workspace_state_unknown',
      'Workspace snapshot truth is corrupt or unreadable; resolve it manually before publishing changes.',
    );
  }
  if (snapshots.length === 0) {
    const workspacePath = lane.worktreePath ? path.resolve(lane.worktreePath) : null;
    if (!workspacePath) {
      throw new WorkspaceMutationUnavailableError(
        'workspace_state_unknown',
        'Managed workspace path is absent, so publication was refused.',
      );
    }
    try {
      return await assertManagedWorkspaceMaterialization(lane.repoPath, workspacePath);
    } catch (error) {
      throw new WorkspaceMutationUnavailableError(
        'workspace_state_unknown',
        error instanceof Error ? error.message : 'Managed workspace ownership could not be verified.',
      );
    }
  }
  if (snapshots.length !== 1) {
    throw new WorkspaceMutationUnavailableError(
      'workspace_state_unknown',
      'Workspace snapshot truth is ambiguous; resolve it manually before publishing changes.',
    );
  }
  const snapshot = snapshots[0]!;
  if (snapshot.state !== 'materialized') {
    throw new WorkspaceMutationUnavailableError(
      'workspace_restore_required',
      `Workspace is ${snapshot.state}; restore it before publishing changes.`,
    );
  }
  const repo = await findRepoByLocalPath(lane.repoPath).catch(() => null);
  const workspacePath = lane.worktreePath ? path.resolve(lane.worktreePath) : null;
  if (!repo
    || repo.id !== snapshot.repositoryUuid
    || snapshot.packetId !== packetId
    || snapshot.laneId !== lane.id
    || !workspacePath
    || path.resolve(snapshot.originalPath) !== workspacePath
    || path.resolve(repo.localPath) !== path.resolve(lane.repoPath)) {
    throw new WorkspaceMutationUnavailableError(
      'workspace_state_unknown',
      'Materialized workspace identity does not match its packet, lane, repository, and exact path.',
    );
  }
  try {
    return await assertManagedWorkspaceMaterialization(repo.localPath, workspacePath);
  } catch (error) {
    throw new WorkspaceMutationUnavailableError(
      'workspace_state_unknown',
      error instanceof Error ? error.message : 'Managed workspace ownership could not be verified.',
    );
  }
}

/** Hold the packet lifecycle lock from durable state proof through publication. */
export async function withWorkspaceMaterializedMutation<T>(
  lane: Lane,
  operation: () => Promise<T>,
): Promise<T> {
  const packetId = lane.packetId?.trim();
  if (!packetId) {
    const identity = await assertWorkspaceMaterializedForMutation(lane);
    return identity && lane.worktreePath
      ? withWorktreeMaterializationExecution(lane.worktreePath, identity, operation)
      : operation();
  }
  const held = heldMutationPackets.getStore();
  if (held?.get(packetId)?.active) {
    const identity = await assertWorkspaceMaterializedForMutation(lane);
    return identity && lane.worktreePath
      ? withWorktreeMaterializationExecution(lane.worktreePath, identity, operation)
      : operation();
  }
  return withPacketLifecycleMutationLock(packetId, async ({ contended }) => {
    if (contended) {
      throw new WorkspaceMutationUnavailableError(
        'workspace_state_unknown',
        'Another workspace lifecycle mutation ran first; retry after its durable outcome is visible.',
      );
    }
    const identity = await assertWorkspaceMaterializedForMutation(lane);
    const authority: MutationAuthority = { active: true };
    const run = async () => {
      try {
        return await heldMutationPackets.run(new Map([...(held ?? []), [packetId, authority]]), operation);
      } finally { authority.active = false; }
    };
    return identity && lane.worktreePath
      ? withWorktreeMaterializationExecution(lane.worktreePath, identity, run)
      : run();
  });
}
