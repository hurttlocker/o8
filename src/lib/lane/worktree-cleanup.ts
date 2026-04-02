import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getWorktreeManager } from '@/lib/worktree/launch';
import type { Lane } from './types';

const execFileAsync = promisify(execFile);

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function cleanupLaneWorktree(
  lane: Pick<Lane, 'id' | 'repoPath' | 'worktreePath'>,
): Promise<boolean> {
  const worktreePath = lane.worktreePath?.trim();
  if (!worktreePath) {
    return false;
  }

  try {
    const manager = getWorktreeManager(lane.repoPath);
    const worktree = (await manager.list()).find((candidate) => candidate.path === worktreePath);
    if (worktree) {
      await manager.cleanup(worktree.id, { force: true, deleteBranch: true });
      return true;
    }
  } catch (error) {
    console.warn(`[lane-worktree] Manager cleanup failed for ${lane.id}: ${formatError(error)}`);
  }

  try {
    await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: lane.repoPath,
      timeout: 15_000,
    });
    await execFileAsync('git', ['worktree', 'prune'], {
      cwd: lane.repoPath,
      timeout: 10_000,
    }).catch(() => {});
    return true;
  } catch (error) {
    const message = formatError(error);
    if (
      message.includes('is not a working tree')
      || message.includes('not a working tree')
      || message.includes('No such file or directory')
    ) {
      return false;
    }
    console.error(`[lane-worktree] Cleanup failed for ${lane.id}: ${message}`);
    return false;
  }
}

export async function pruneRepoWorktrees(repoPath: string): Promise<string[]> {
  return getWorktreeManager(repoPath).prune();
}
