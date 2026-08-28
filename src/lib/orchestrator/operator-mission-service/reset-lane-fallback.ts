import { supersedeDurableApprovedReviews } from '@/lib/lane/durable-review-approval';
import { removeCortexWorktreePath } from '@/lib/lane/worktree-clone-removal';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { collectPacketLifecycleLanes } from '@/lib/orchestrator/packet-lifecycle-targets';
import { unregisterWatchedAgent } from '@/lib/supervisor/agent-supervisor';
import { managedPacketWorktreeId, resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';
import { cleanupResetPacketTargets, type ResetCleanupTarget } from './reset-cleanup';
import { ResetCleanupFailedError } from './reset-errors';
import { archiveResetLaneSessions, confirmedKilledLaneIds } from './reset-lifecycle-retirement';
import { log } from './shared';
import type { ResetPacketInput } from './types';
import { storageOwnerGenerationForLane } from '@/lib/orchestrator/terminal-storage-release';
import { archiveWorkspaceManifestRunForReset } from '@/lib/workspace/manifest/lifecycle';

export interface ResetAuthoritativeBinding {
  packet: OrchestratorPacket;
  repoPath: string;
}

function withinScope(input: ResetPacketInput, laneId: string): boolean {
  return !input.scope || input.scope.laneIds.includes(laneId);
}

export async function resetPacketViaLaneFallback(
  input: ResetPacketInput,
  authoritative?: ResetAuthoritativeBinding,
) {
  const { archiveLane, listLanes, updateLane } = await import('@/lib/lane/registry');
  const persisted = listLanes().filter((lane) => lane.packetId === input.packetId);
  const allBound = (authoritative
    ? collectPacketLifecycleLanes(authoritative.packet, authoritative.repoPath, persisted)
    : persisted
  ).filter((lane) => withinScope(input, lane.id));
  const persistedIds = new Set(persisted.map((lane) => lane.id));
  const referenceLabel = authoritative?.packet.referenceLabel ?? input.packetId;

  if (allBound.length === 0) {
    throw new Error(`Packet ${input.packetId} not found — no mission packet and no lane.`);
  }
  await supersedeDurableApprovedReviews(input.packetId, 'Superseded by reset_packet.');

  const bound: typeof allBound = [];
  for (const lane of allBound) {
    await archiveWorkspaceManifestRunForReset({
      worktreePath: lane.worktreePath,
      packetId: input.packetId,
      laneId: lane.id,
    });
    if (lane.status !== 'archived' && lane.status !== 'completed') {
      bound.push(lane);
      continue;
    }
    if (!persistedIds.has(lane.id)) continue;
    try {
      const updated = updateLane(lane.id, { packetId: '', worktreePath: null });
      if (!updated) throw new Error('lane disappeared during reset update');
    } catch (error) {
      throw resetRetirementFailure(input, referenceLabel, `terminal lane ${lane.id} could not be unbound`, error);
    }
  }

  const confirmedKills = await confirmedKilledLaneIds(bound);
  await archiveResetLaneSessions(bound);
  for (const lane of bound) {
    if (lane.sessionKey?.trim()) unregisterWatchedAgent(lane.sessionKey.trim());
  }

  const cleanupTargets: ResetCleanupTarget[] = [];
  for (const lane of bound) {
    cleanupTargets.push({
      id: lane.id,
      repoPath: lane.repoPath,
      branch: lane.branch,
      runtime: lane.runtime,
      worktreePath: lane.worktreePath,
      storageAdmissionOwnerGeneration: authoritative?.packet.storageAdmission?.ownerGeneration
        ?? storageOwnerGenerationForLane(lane.id, input.packetId),
      overrideLiveGuard: confirmedKills.has(lane.id) ? true : undefined,
    });
    if (!persistedIds.has(lane.id)) continue;
    try {
      const updated = updateLane(lane.id, {
        packetId: '',
        worktreePath: null,
        outcome: 'discarded',
        outcomeNote: 'Superseded by reset',
      });
      if (!updated) throw new Error('lane disappeared during reset update');
      const archived = archiveLane(lane.id, 'user');
      if (!archived) throw new Error('lane disappeared during reset archive');
    } catch (error) {
      throw resetRetirementFailure(input, referenceLabel, `lane ${lane.id} could not be retired`, error);
    }
  }

  let worktreePruned = false;
  let branchDeleted = false;
  if (input.clearWorktree) {
    try {
      const cleanup = await cleanupResetPacketTargets(cleanupTargets, input.packetId);
      worktreePruned = cleanup.worktreePruned;
      branchDeleted = cleanup.branchDeleted;
    } catch (error) {
      throw resetRetirementFailure(input, referenceLabel, 'worktree cleanup was not confirmed', error);
    }

    if (!input.scope) try {
      const { readdir } = await import('node:fs/promises');
      const path = await import('node:path');
      for (const repoPath of new Set(allBound.map((lane) => lane.repoPath))) {
        for (const baseDir of resolveWorktreeRootLayout(repoPath).bases) {
          const dirs = await readdir(baseDir).catch(() => [] as string[]);
          const prefix = managedPacketWorktreeId(input.packetId);
          if (!prefix) continue;
          for (const name of dirs.filter((entry) => entry === prefix || entry.startsWith(`${prefix}-`))) {
            const full = path.join(baseDir, name);
            const removed = await removeCortexWorktreePath({
              repoRoot: repoPath,
              worktreePath: full,
              logPrefix: 'lane-reset-orphan',
              operatorForce: true,
            });
            if (removed) worktreePruned = true;
          }
        }
      }
    } catch (error) {
      log(
        `[lane-reset] Orphan worktree sweep failed for evicted packet ${input.packetId}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return {
    reset: true,
    salvaged: false,
    packetId: input.packetId,
    referenceLabel,
    worktreePruned,
    branchDeleted,
    note: `Packet ${referenceLabel} reset via lane fallback — old lane retired.${worktreePruned ? ' Worktree pruned.' : ''}${branchDeleted ? ' Branch deleted.' : ''} Call dispatch_mission to re-launch.`,
  };
}

function resetRetirementFailure(
  input: ResetPacketInput,
  referenceLabel: string,
  action: string,
  error: unknown,
): ResetCleanupFailedError {
  return new ResetCleanupFailedError({
    reset: false,
    salvaged: false,
    partial: true,
    packetId: input.packetId,
    referenceLabel,
    worktreePruned: false,
    branchDeleted: false,
    note: `Packet ${referenceLabel} worker was stopped, but ${action}. The packet must not be relaunched: ${error instanceof Error ? error.message : String(error)}`,
  });
}
