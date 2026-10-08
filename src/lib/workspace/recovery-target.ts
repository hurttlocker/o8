import path from 'node:path';

import { findLatestLaneByPacket } from '@/lib/lane/registry';
import { listRepos } from '@/lib/repos/registry';
import { canonicalRepoRoot } from '@/lib/worktree/root-layout';
import { readManagedWorkspaceMaterialization } from './managed-materialization-identity';

export async function resolvePacketRecoveryTarget(packetId: string) {
  const lane = findLatestLaneByPacket(packetId);
  if (!lane || lane.packetId !== packetId || lane.ownership !== 'managed') {
    throw new Error('The packet has no managed workspace owner.');
  }
  const repos = await listRepos();
  const repo = repos.find((entry) => canonicalRepoRoot(entry.localPath) === canonicalRepoRoot(lane.repoPath));
  if (!repo) throw new Error('The packet repository is not registered.');
  return { lane, repo };
}

export async function resolveMaterializedRecoveryTarget(packetId: string) {
  const target = await resolvePacketRecoveryTarget(packetId);
  if (!target.lane.worktreePath) throw new Error('The packet workspace is not materialized.');
  const managed = await readManagedWorkspaceMaterialization(target.repo.localPath, target.lane.worktreePath);
  const parent = managed.metadata.materializationParentIdentity;
  if (!parent || managed.identity.canonicalPath === canonicalRepoRoot(target.repo.localPath)
    || managed.identity.canonicalPath !== path.join(parent.canonicalPath, managed.metadata.id)) {
    throw new Error('The packet workspace lacks exact isolated ownership.');
  }
  return { ...target, ...managed };
}
