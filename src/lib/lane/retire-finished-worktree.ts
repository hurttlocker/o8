import { getLane, updateLane, appendEvent } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { isLaneTerminal } from '@/lib/lane/terminal-states';
import { withPacketLifecycleSpawnLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { withCloseTiming } from '@/lib/orchestrator/close-timing';
import { prepareOrphanCloseOwners, withOrphanCloseContext } from '@/lib/orchestrator/close-orphaned-owner';
import { removeMergedWorktree, type RemoveMergedWorktreeResult } from '@/lib/orchestrator/worktree-cleanup';

/** Explicit archive waits for exact retirement, without authorizing live or dirty removal. */
export async function retireFinishedWorktree(candidate: Lane): Promise<boolean> {
  return (await retireFinishedWorktreeWithResult(candidate)).removed;
}

/** Return the same refusal recorded on the lane to callers waiting for Close. */
export async function retireFinishedWorktreeWithResult(candidate: Lane): Promise<RemoveMergedWorktreeResult> {
  if (!candidate.packetId || !candidate.worktreePath || candidate.ownership !== 'managed') {
    return { removed: false, reason: 'ownership-unavailable' };
  }
  return withPacketLifecycleSpawnLock(candidate.packetId, () => withCloseTiming(candidate.packetId!, () =>
    withOrphanCloseContext(candidate.packetId!, async () => {
      const lane = getLane(candidate.id);
      if (!lane || lane.worktreePath !== candidate.worktreePath || lane.packetId !== candidate.packetId
        || !isLaneTerminal(lane.status)) return { removed: false, reason: 'ownership-unavailable' };
      try {
        await prepareOrphanCloseOwners([lane]);
        const current = getLane(lane.id);
        if (!current || !isLaneTerminal(current.status) || current.worktreePath !== lane.worktreePath
          || current.packetId !== lane.packetId) return { removed: false, reason: 'ownership-unavailable' };
        const cleanup = await removeMergedWorktree(lane);
        if (!cleanup.removed) {
          appendEvent(lane.id, 'update', 'system', { phase: 'archive_cleanup_held', reason: cleanup.reason, detail: cleanup.detail });
          return cleanup;
        }
        updateLane(lane.id, { worktreePath: null, outcome: lane.outcome, outcomeNote: lane.outcomeNote },
          'system', { phase: 'archive_cleanup_retired' });
        return cleanup;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        appendEvent(lane.id, 'update', 'system', { phase: 'archive_cleanup_held',
          detail });
        return { removed: false, reason: 'retirement-refused', detail };
      }
    })));
}
