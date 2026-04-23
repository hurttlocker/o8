import { getWorktreeManager } from '@/lib/worktree/launch';
import { currentMissionState, log } from './shared';
import type { ResetPacketInput } from './types';

export async function resetPacket(input: ResetPacketInput) {
  const state = currentMissionState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  if (!packet) {
    throw new Error(`Packet ${input.packetId} not found.`);
  }

  // Archive ALL stale lanes bound to this packet and clear their packet
  // binding so the reconciler doesn't re-attach them to this packet OR
  // rebind them to the next new mission that happens to share the same
  // branch slug (v1 ship bug: reconciler was picking up orphan lanes left
  // behind when `packet.lane` was already null in mission state but SQLite
  // still held an active row tied to `packet.id`).
  //
  // We sweep SQLite directly via listLanes() rather than trusting
  // packet.lane because store.reconcileOrchestratorMissionState() can
  // null packet.lane while leaving the SQLite row in a non-terminal status.
  let worktreePath: string | null = null;
  try {
    const { archiveLane, listLanes, updateLane } = await import('@/lib/lane/registry');
    const bound = listLanes().filter(
      (lane) => lane.packetId === packet.id
        && lane.status !== 'archived'
        && lane.status !== 'completed',
    );
    if (bound.length === 0) {
      console.log(`[reset-packet] No active lane bound to packet ${packet.referenceLabel} (${packet.id})`);
    }
    for (const lane of bound) {
      // First seen worktree wins for the pruning path below — matches the
      // previous single-lane behavior.
      if (!worktreePath && lane.worktreePath) {
        worktreePath = lane.worktreePath;
      }
      try {
        // Clear packetId first so reconciler can't re-bind this lane.
        updateLane(lane.id, { packetId: '' });
        archiveLane(lane.id, 'user');
        console.log(`[reset-packet] Archived stale lane ${lane.id} for packet ${packet.referenceLabel}`);
      } catch (error) {
        console.warn(
          `[reset-packet] Could not archive lane ${lane.id} — may already be gone: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    console.warn(
      `[reset-packet] Lane registry lookup failed for packet ${packet.referenceLabel}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // If clearWorktree requested, prune the old worktree directory
  let worktreePruned = false;
  if (input.clearWorktree && worktreePath && state.repoPath) {
    try {
      const manager = await getWorktreeManager(state.repoPath);
      const worktrees = await manager.list();
      const match = worktrees.find((wt) => worktreePath!.includes(wt.id));
      if (match) {
        await manager.cleanup(match.id, { force: true, deleteBranch: true });
        worktreePruned = true;
        log(`[lane-reset] Pruned worktree ${match.id} for packet ${packet.referenceLabel}`);
      }
    } catch {
      log(`[lane-reset] Could not prune worktree at ${worktreePath} — may already be gone`);
    }
  }

  // Reset packet to dispatchable state
  // #455 — lane MUST be null, not a blank object. A truthy lane with empty laneId
  // causes the reconciler to see "has lane but no domain match" → 'recovering',
  // which races the next dispatch tick and traps the packet in a recovery loop.
  packet.status = 'draft';
  packet.queueState = 'queued';
  packet.releaseState = 'pending';
  packet.blockedReason = null;
  packet.lane = null;
  packet.review = null;
  packet.lastEventAt = null;
  packet.lastEventLabel = null;
  // #455 — Clear recovery counter so a manual reset gives fresh retry budget
  packet.recoveryCount = 0;
  packet.lastRecoveryAt = null;

  // Persist
  const { updateOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  updateOrchestratorMissionState(state);
  log(`Reset packet ${packet.referenceLabel} (${input.packetId}). Reason: ${input.reason ?? 'operator reset'}`);

  return {
    reset: true,
    packetId: input.packetId,
    referenceLabel: packet.referenceLabel,
    worktreePruned,
    note: `Packet ${packet.referenceLabel} reset to queued/draft. Old lane archived.${worktreePruned ? ' Worktree pruned.' : ''} Ready for re-dispatch.`,
  };
}
