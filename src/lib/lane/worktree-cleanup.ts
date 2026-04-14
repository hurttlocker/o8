import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { getWorktreeManager } from '@/lib/worktree/launch';
import type { Lane } from './types';

const execFileAsync = promisify(execFile);

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Check for uncommitted changes and auto-commit before cleanup.
 * Returns true if safe to proceed, false if prune should be skipped.
 */
async function preserveUncommittedWork(worktreePath: string, laneId: string): Promise<boolean> {
  try {
    await access(worktreePath);
  } catch {
    return true; // Directory gone, safe to proceed
  }

  try {
    const { stdout: status } = await execFileAsync(
      'git', ['status', '--porcelain'],
      { cwd: worktreePath, timeout: 5000 },
    );
    if (!status.trim()) return true; // Clean, safe to proceed

    console.log(`[worktree-prune] Lane ${laneId} has uncommitted changes — preserving work`);

    try {
      await execFileAsync('git', ['add', '-A'], { cwd: worktreePath, timeout: 10_000 });
      await execFileAsync(
        'git', ['commit', '-m', 'chore: preserve agent work before worktree cleanup'],
        { cwd: worktreePath, timeout: 10_000 },
      );
      console.log(`[worktree-prune] Auto-committed changes for lane ${laneId}`);
      return true;
    } catch {
      console.log(`[worktree-prune] Auto-commit failed for lane ${laneId}, skipping prune to preserve work`);
      return false;
    }
  } catch {
    // git status failed — worktree might be corrupt, safe to proceed
    return true;
  }
}

export async function cleanupLaneWorktree(
  lane: Pick<Lane, 'id' | 'repoPath' | 'worktreePath'>,
): Promise<boolean> {
  const worktreePath = lane.worktreePath?.trim();
  if (!worktreePath) {
    return false;
  }

  // Safety guard: never touch the main working tree. A lane whose
  // worktreePath equals its repoPath is an un-isolated session running in
  // the main checkout — `git worktree remove` would fail and, worse,
  // `preserveUncommittedWork` would drop a rogue "chore: preserve agent
  // work" commit onto whatever branch main is currently on. Bail cleanly.
  const repoPath = lane.repoPath.replace(/\/+$/, '');
  const normalizedWorktree = worktreePath.replace(/\/+$/, '');
  if (normalizedWorktree === repoPath) {
    console.warn(`[lane-worktree] Skipping cleanup for ${lane.id}: worktree path equals repo path (no isolation).`);
    return false;
  }

  try {
    const manager = getWorktreeManager(lane.repoPath);
    const worktree = (await manager.list()).find((candidate) => candidate.path === worktreePath);
    if (worktree) {
      // manager.cleanup already calls preserveUncommittedWork internally
      await manager.cleanup(worktree.id, { force: true, deleteBranch: true });
      return true;
    }
  } catch (error) {
    console.warn(`[lane-worktree] Manager cleanup failed for ${lane.id}: ${formatError(error)}`);
  }

  // Fallback: direct git worktree remove — also needs safety check
  const safeToRemove = await preserveUncommittedWork(worktreePath, lane.id);
  if (!safeToRemove) return false;

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
