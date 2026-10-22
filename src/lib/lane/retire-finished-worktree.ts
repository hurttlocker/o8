import { getLane, updateLane, appendEvent } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { isLaneTerminal } from '@/lib/lane/terminal-states';
import { withPacketLifecycleSpawnLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { withCloseTiming } from '@/lib/orchestrator/close-timing';
import { prepareOrphanCloseOwners, withOrphanCloseContext } from '@/lib/orchestrator/close-orphaned-owner';
import { removeMergedWorktree } from '@/lib/orchestrator/worktree-cleanup';

/** Explicit archive waits for exact retirement, without authorizing live or dirty removal. */
export async function retireFinishedWorktree(candidate: Lane): Promise<boolean> {
  if (!candidate.packetId || !candidate.worktreePath || candidate.ownership !== 'managed') return false;
  return withPacketLifecycleSpawnLock(candidate.packetId, () => withCloseTiming(candidate.packetId!, () =>
    withOrphanCloseContext(candidate.packetId!, async () => {
      const lane = getLane(candidate.id);
      if (!lane || lane.worktreePath !== candidate.worktreePath || lane.packetId !== candidate.packetId
        || !isLaneTerminal(lane.status)) return false;
      try {
        await prepareOrphanCloseOwners([lane]);
        const current = getLane(lane.id);
        if (!current || !isLaneTerminal(current.status) || current.worktreePath !== lane.worktreePath
          || current.packetId !== lane.packetId) return false;
        const cleanup = await removeMergedWorktree(lane);
        if (!cleanup.removed) {
          appendEvent(lane.id, 'update', 'system', { phase: 'archive_cleanup_held', reason: cleanup.reason, detail: cleanup.detail });
          return false;
        }
        updateLane(lane.id, { worktreePath: null, outcome: lane.outcome, outcomeNote: lane.outcomeNote },
          'system', { phase: 'archive_cleanup_retired' });
        return true;
      } catch (error) {
        appendEvent(lane.id, 'update', 'system', { phase: 'archive_cleanup_held',
          detail: error instanceof Error ? error.message : String(error) });
        return false;
      }
    })));
}
