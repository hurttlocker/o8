import { access } from 'node:fs/promises';
import path from 'node:path';

import { appendEvent, setLaneStatus } from '@/lib/lane/registry';
import type { Lane, LaneCommandResult } from '@/lib/lane/types';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import { retireDependencyImage } from '@/lib/workspace/apfs-dependency-image';
import { detachDependencyMaterialization } from '@/lib/workspace/dependency-materializer';
import {
  DEPENDENCY_MATERIALIZATION_INCOMPLETE,
  DependencyMaterializationIncompleteError,
  isDependencyMaterializationIncomplete,
  verifyDependencyMaterialization,
} from '@/lib/workspace/dependency-materialization-verification';
import type { WorktreeManager } from '@/lib/worktree/manager';

async function hasPackageJson(workspacePath: string): Promise<boolean> {
  try {
    await access(path.join(workspacePath, 'package.json'));
    return true;
  } catch {
    return false;
  }
}

export async function blockIncompleteMergeDependencies(
  input: { lane: Lane; command: { laneId: string } },
  manager: WorktreeManager,
  verificationPath: string,
): Promise<LaneCommandResult | null> {
  if (!(await hasPackageJson(verificationPath))) return null;
  const verification = await verifyDependencyMaterialization(verificationPath);
  if (!isDependencyMaterializationIncomplete(verification)) return null;

  let materializationPath = verificationPath;
  let worktree = await manager.getDependencyMaterializationByPath(verificationPath);
  if (!worktree && input.lane.worktreePath && input.lane.worktreePath !== verificationPath) {
    // A canonical-repo relocation verifies a temporary merge checkout while its dependency
    // receipt remains attached to the packet clone, so only that divergence uses the lane path.
    materializationPath = input.lane.worktreePath;
    worktree = await manager.getDependencyMaterializationByPath(materializationPath);
  }
  const materialization = worktree?.dependencyMaterialization ?? null;
  let imageGenerationInvalidated = false;
  let imageInvalidationError: string | null = null;
  if (materialization?.mode === 'image') {
    try {
      await detachDependencyMaterialization(materializationPath, materialization);
      if (worktree) await manager.clearDependencyMaterialization(worktree.id);
      await retireDependencyImage(materialization.recipeKey);
      imageGenerationInvalidated = true;
    } catch (error) {
      imageInvalidationError = error instanceof Error ? error.message : String(error);
    }
  }

  const blocker = new DependencyMaterializationIncompleteError(
    verification,
    imageGenerationInvalidated,
    imageInvalidationError,
  );
  appendEvent(input.command.laneId, DEPENDENCY_MATERIALIZATION_INCOMPLETE, 'system', {
    code: blocker.code,
    packetId: input.lane.packetId,
    phase: 'merge_gate',
    mode: materialization?.mode ?? null,
    recipeKey: materialization?.recipeKey ?? null,
    topLevelEntryCount: verification.topLevelEntryCount,
    verifiedBinaries: verification.verifiedBinaries,
    missingBinaries: verification.missingBinaries,
    resolutionErrors: verification.resolutionErrors,
    scriptBinaries: verification.scriptBinaries,
    unreadableFiles: verification.unreadableFiles,
    imageGenerationInvalidated,
    imageInvalidationError,
  });
  setLaneStatus(
    input.command.laneId,
    'awaiting_orchestrator',
    'system',
    DEPENDENCY_MATERIALIZATION_INCOMPLETE,
  );

  const recordedAt = new Date().toISOString();
  try {
    await withLockedState((state) => {
      const packet = state.packets.find((candidate) => candidate.id === input.lane.packetId);
      if (!packet) return;
      packet.status = 'blocked';
      packet.blockedReason = blocker.message;
      packet.lastEventAt = recordedAt;
      packet.lastEventLabel = DEPENDENCY_MATERIALIZATION_INCOMPLETE;
      if (packet.lane?.laneId === input.command.laneId) {
        packet.lane.lastEventAt = recordedAt;
        packet.lane.lastEventLabel = DEPENDENCY_MATERIALIZATION_INCOMPLETE;
      }
    });
  } catch (error) {
    console.warn(
      `[lane-merge] Could not persist dependency blocker for packet ${input.lane.packetId ?? 'unknown'}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    ok: false,
    laneId: input.command.laneId,
    note: blocker.message,
    reason: DEPENDENCY_MATERIALIZATION_INCOMPLETE,
  };
}
