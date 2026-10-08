import path from 'node:path';

import { listLanes } from '@/lib/lane/registry';
import { withPacketLifecycleSpawnLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import { getOwnedSessionLifecycle } from '@/lib/runtimes/shared/owned-session-lifecycle';
import { checkWorktreeRemoval } from '@/lib/worktree/live-process-guard';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { readWorktreeMetaSnapshot } from '@/lib/worktree/metadata-store';
import { canonicalRepoRoot } from '@/lib/worktree/root-layout';
import { probeOwnedSessionProcessQuiescence } from './process-probes';

function owningLanes(repositoryPath: string, sourcePath: string) {
  return listLanes().filter((lane) => lane.worktreePath
    && path.resolve(lane.worktreePath) === path.resolve(sourcePath)
    && canonicalRepoRoot(lane.repoPath) === canonicalRepoRoot(repositoryPath));
}

/** Reuse only live scoped authority; a cold cleanup takes the same lease as spawn. */
export async function withManagedRetirementOwnership<T>(
  repositoryPath: string,
  sourcePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lanes = owningLanes(repositoryPath, sourcePath);
  if (lanes.length > 1) throw new Error('Retirement has ambiguous durable lane ownership.');
  return withPacketLifecycleSpawnLock(lanes[0]?.packetId ?? null, operation);
}

/** Prove the current owner before source writes and every destructive/replay seam. */
export async function assertManagedRetirementQuiescence(input: {
  repositoryPath: string;
  worktreeId: string;
  sourcePath: string;
  candidatePath: string;
  identity: WorktreeMaterializationIdentity;
}): Promise<{ repositoryUuid: string | null; packetId: string | null; laneId: string | null; sessionKey: string | null }> {
  const sourcePath = path.resolve(input.sourcePath);
  const metadata = (await readWorktreeMetaSnapshot(input.repositoryPath))[input.worktreeId];
  if (!metadata || metadata.claudeManaged || metadata.status !== 'ready'
    || metadata.materializationIdentity?.canonicalPath !== sourcePath
    || metadata.materializationIdentity.device !== input.identity.device
    || metadata.materializationIdentity.inode !== input.identity.inode
    || !metadata.materializationParentIdentity
    || path.join(metadata.materializationParentIdentity.canonicalPath, input.worktreeId) !== sourcePath) {
    throw new Error('Retirement has no exact ready manager process authority.');
  }
  const lanes = owningLanes(input.repositoryPath, sourcePath);
  if (lanes.length === 0 && !metadata.sessionKey) {
    if (!(await checkWorktreeRemoval(input.candidatePath, { logPrefix: 'standalone-retirement' })).allowed) {
      throw new Error('Standalone retirement process truth is live or unknown.');
    }
    return { repositoryUuid: null, packetId: null, laneId: null, sessionKey: null };
  }
  const lane = lanes.length === 1 ? lanes[0] : null;
  const sessionKey = lane?.sessionKey?.trim();
  if (!lane?.packetId || !sessionKey || metadata.sessionKey !== sessionKey) {
    throw new Error('Retirement lacks an unambiguous durable packet and owned session.');
  }
  const repo = await findRepoByLocalPath(canonicalRepoRoot(input.repositoryPath));
  if (!repo) throw new Error('Retirement repository is no longer registered.');
  // Cold worktree routes must resolve the canonical adapters before probing.
  await import('@/lib/runtimes');
  const lifecycle = getOwnedSessionLifecycle(sessionKey);
  const receipt = await lifecycle?.getWorkspaceBinding?.(sessionKey);
  if (!receipt || receipt.surfaceId !== sessionKey || receipt.sessionState !== 'active'
    || receipt.binding.packetId !== lane.packetId
    || receipt.binding.logicalWorkspaceId !== `packet:${lane.packetId}`
    || (receipt.binding.repositoryUuid !== null && receipt.binding.repositoryUuid !== repo.id)
    || path.resolve(receipt.binding.cwd) !== sourcePath) {
    throw new Error('Retirement owned-session binding is missing, archived, or belongs to another workspace.');
  }
  const process = await probeOwnedSessionProcessQuiescence(sessionKey, input.candidatePath);
  if (process.state !== 'quiescent') {
    throw new Error(`Retirement owned-workspace process truth is ${process.state}.`);
  }
  return { repositoryUuid: repo.id, packetId: lane.packetId, laneId: lane.id, sessionKey };
}
