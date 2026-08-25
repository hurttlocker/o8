import type { WorktreeManager } from '@/lib/worktree/manager';
import { appendEvent, updateLane } from './registry';
import type { Lane } from './types';

export async function settleSuccessfulMergeWorktreeCleanup(input: {
  manager: WorktreeManager;
  lane: Pick<Lane, 'id' | 'branch' | 'baseBranch' | 'worktreePath'>;
  worktreeId: string;
  pushedToOrigin: boolean;
  mergedEquivalentHeadSha?: string;
}): Promise<boolean> {
  let worktreeRemoved = false;
  try {
    worktreeRemoved = await input.manager.cleanup(input.worktreeId, {
      force: true,
      deleteBranch: true,
      mergedEquivalentHeadSha: input.mergedEquivalentHeadSha,
      workspaceRetirementAction: 'merge',
    });
  } catch (error) {
    console.warn(`[lane-merge] Worktree cleanup remains pending for ${input.lane.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  void input.manager.prune().catch(() => {});
  updateLane(input.lane.id, {
    ...(worktreeRemoved ? { worktreePath: null } : {}),
    outcome: 'merged',
    outcomeNote: `Merged ${input.lane.branch} into ${input.lane.baseBranch}${input.pushedToOrigin ? ' and pushed to origin' : ''}.${worktreeRemoved ? '' : ' Worktree cleanup is pending and will retry.'}`,
  }, 'system');
  appendEvent(input.lane.id, 'update', 'system', {
    phase: 'merge_cleanup',
    worktreeRemoved,
    worktreePath: worktreeRemoved ? null : input.lane.worktreePath,
  });
  return worktreeRemoved;
}
