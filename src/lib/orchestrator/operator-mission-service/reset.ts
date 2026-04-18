import { getWorktreeManager } from '@/lib/worktree/launch';
import { currentMissionState, log } from './shared';
import type { ResetPacketInput } from './types';

export async function resetPacket(input: ResetPacketInput) {
  const state = currentMissionState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  if (!packet) {
    throw new Error(`Packet ${input.packetId} not found.`);
  }

  // Archive the old lane and clear its packet binding so the reconciler
  // doesn't re-attach it to this packet
  let worktreePath: string | null = null;
  if (packet.lane?.laneId) {
    try {
      const { archiveLane, findLaneByPacket: findLane, updateLane } = await import('@/lib/lane/registry');
      const lane = findLane(packet.id);
      worktreePath = lane?.worktreePath ?? null;
      // Clear packetId first so reconciler won't find this lane
      updateLane(packet.lane.laneId, { packetId: '' });
      archiveLane(packet.lane.laneId, 'user');
      log(`Archived stale lane ${packet.lane.laneId} for packet ${packet.referenceLabel}`);
    } catch {
      log(`Could not archive lane ${packet.lane.laneId} — may already be gone`);
    }
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
