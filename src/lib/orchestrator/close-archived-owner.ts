import path from 'node:path';
import { realpath } from 'node:fs/promises';

import { getSqlite } from '@/lib/db';
import { getLane, updateLane } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { exactWorkspaceOwningLanes } from '@/lib/lane/workspace-ownership-query';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import { getOwnedSessionLifecycle } from '@/lib/runtimes/shared/owned-session-lifecycle';
import {
  archivedSessionPathForSurfaceId,
  assertArchivedWorkspaceSessionRestorable,
  ownedSessionRecordFingerprint,
} from '@/lib/runtimes/shared/owned-session/archive';
import { readOwnedSessionMetadata } from '@/lib/runtimes/shared/owned-session/metadata-read';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import { readManagedWorkspaceMaterialization } from '@/lib/workspace/managed-materialization-identity';
import { probeOwnedSessionProcessQuiescence } from '@/lib/workspace/process-probes';
import { canonicalRepoRoot } from '@/lib/worktree/root-layout';

/**
 * Explicit adopted-elsewhere Close may recover only the original archived owner.
 * This never restores the archive or changes ordinary Stop/Close process authority.
 * The caller holds the packet lifecycle lock; retirement rechecks native quiescence.
 */
export async function recoverArchivedCloseOwner(packetId: string, targets: Lane[]): Promise<{
  targets: Lane[];
  bindingKey: string;
} | null> {
  try {
    const target = targets[0];
    if (!target?.worktreePath || targets.some((candidate) => candidate.id !== target.id
      || candidate.worktreePath !== target.worktreePath || candidate.repoPath !== target.repoPath)) return null;
    const lane = getLane(target.id);
    if (!lane || lane.packetId !== packetId || lane.ownership !== 'managed'
      || lane.worktreePath !== target.worktreePath || lane.repoPath !== target.repoPath
      || lane.branch !== target.branch || lane.runtime !== target.runtime) return null;
    const managed = await readManagedWorkspaceMaterialization(lane.repoPath, lane.worktreePath!);
    const sessionKey = managed.metadata.sessionKey?.trim();
    if (!sessionKey || managed.metadata.status !== 'ready' || managed.metadata.agentType !== lane.runtime
      || managed.metadata.branchName !== lane.branch
      || (lane.sessionKey && lane.sessionKey !== sessionKey)
      || targets.some((candidate) => candidate.sessionKey && candidate.sessionKey !== sessionKey)) return null;
    const owners = exactWorkspaceOwningLanes(lane.repoPath, lane.worktreePath!, managed.metadata);
    if (owners.length !== 1 || owners[0]?.id !== lane.id) return null;
    const repo = await findRepoByLocalPath(canonicalRepoRoot(lane.repoPath));
    if (!repo) return null;

    await import('@/lib/runtimes');
    const lifecycle = getOwnedSessionLifecycle(sessionKey);
    const receipt = await lifecycle?.getWorkspaceBinding?.(sessionKey);
    if (!lifecycle || lifecycle.runtimeId !== lane.runtime || !receipt?.recordFingerprint
      || receipt.surfaceId !== sessionKey || receipt.runtimeId !== lane.runtime
      || receipt.sessionState !== 'archived' || receipt.activeRun || receipt.detached
      || receipt.binding.packetId !== packetId || receipt.binding.logicalWorkspaceId !== `packet:${packetId}`
      || (receipt.binding.repositoryUuid !== null && receipt.binding.repositoryUuid !== repo.id)
      || await realpath(receipt.binding.cwd) !== managed.identity.canonicalPath) return null;
    const root = lifecycle.resolveRoot();
    await assertArchivedWorkspaceSessionRestorable(root, sessionKey, lifecycle.surfaceIdPrefix, receipt.recordFingerprint);
    const archivePath = await archivedSessionPathForSurfaceId(root, sessionKey, lifecycle.surfaceIdPrefix);
    if (!archivePath) return null;
    const record = await readOwnedSessionMetadata<OwnedSessionRecord>(path.join(archivePath, 'session.json'));
    const ledger = record.runIdentityLedger;
    if (record.surfaceId !== sessionKey || record.packetId !== packetId || record.laneId !== lane.id
      || record.activeRun || record.detachedAt || await realpath(record.cwd) !== managed.identity.canonicalPath
      || ownedSessionRecordFingerprint(record) !== receipt.recordFingerprint
      || ledger?.version !== 1 || ledger.complete !== true || ledger.totalRuns !== record.recentRuns.length
      || record.recentRuns.length === 0 || record.recentRuns.length > 16
      || record.recentRuns.some((run) => run.outcome !== 'finished' || !run.finishedAt
        || run.childExit?.code !== 0 || run.childExit.signal !== null || run.childExit.classification !== 'clean-exit')) return null;
    if ((await probeOwnedSessionProcessQuiescence(sessionKey, lane.worktreePath!, {
      allowArchivedRetirement: true,
    })).state !== 'quiescent') return null;

    // Recheck immutable archive and directory identity before recovering the binding.
    await assertArchivedWorkspaceSessionRestorable(root, sessionKey, lifecycle.surfaceIdPrefix, receipt.recordFingerprint);
    const currentManaged = await readManagedWorkspaceMaterialization(lane.repoPath, lane.worktreePath!);
    if (JSON.stringify(currentManaged) !== JSON.stringify(managed)) return null;
    const recovered = getSqlite().transaction(() => {
      const current = getLane(lane.id);
      const currentOwners = exactWorkspaceOwningLanes(lane.repoPath, lane.worktreePath!, currentManaged.metadata);
      if (JSON.stringify(current) !== JSON.stringify(lane) || currentOwners.length !== 1
        || currentOwners[0]?.id !== lane.id) return false;
      if (!lane.sessionKey) updateLane(lane.id, { sessionKey }, 'system', {
        reason: 'explicit_close_archived_owner_recovered',
      });
      return true;
    })();
    if (!recovered) return null;
    return {
      targets: [{ ...target, sessionKey }],
      bindingKey: `${lane.id}\0${sessionKey}`,
    };
  } catch {
    // Missing, ambiguous or changed authority keeps the existing conservative path.
    return null;
  }
}
