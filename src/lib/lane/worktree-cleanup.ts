import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { getWorktreeManager } from '@/lib/worktree/launch';
import { preserveLaneWorktreeHead } from './worktree-preservation';
import { removeCortexWorktreePath } from './worktree-clone-removal';
import type { Lane } from './types';

const execFileAsync = promisify(execFile);

type CleanupLane = Pick<Lane, 'id' | 'repoPath' | 'worktreePath'> & Partial<Pick<Lane, 'baseBranch'>>;

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function isGitWorktree(worktreePath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: worktreePath,
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function hasUncommittedWork(worktreePath: string): Promise<boolean> {
  try {
    await access(worktreePath);
  } catch {
    return false;
  }

  try {
    const { stdout: status } = await execFileAsync(
      'git', ['status', '--porcelain'],
      { cwd: worktreePath, timeout: 5000 },
    );
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

async function prepareLaneWorktreeRemoval(
  lane: CleanupLane,
  worktreePath: string,
  terminal: boolean,
): Promise<boolean> {
  const gitWorktree = await isGitWorktree(worktreePath);
  if (!gitWorktree) {
    return true;
  }

  const dirty = await hasUncommittedWork(worktreePath);
  if (dirty && !terminal) {
    console.warn(`[lane-worktree] Skipping cleanup for ${lane.id}: non-terminal worktree has uncommitted changes.`);
    return false;
  }

  if (terminal) {
    try {
      const preservation = await preserveLaneWorktreeHead({
        id: lane.id,
        repoPath: lane.repoPath,
        worktreePath,
        baseBranch: lane.baseBranch ?? 'main',
      });
      if (dirty && !preservation.preserved) {
        console.warn(`[lane-worktree] Skipping cleanup for ${lane.id}: dirty terminal worktree has no preserved branch ref.`);
        return false;
      }
    } catch (error) {
      console.warn(`[lane-worktree] Skipping cleanup for ${lane.id}: failed to preserve terminal worktree head (${formatError(error)}).`);
      return false;
    }
  }

  return true;
}

export async function cleanupLaneWorktree(
  lane: CleanupLane,
  opts: { deleteBranch?: boolean; terminal?: boolean } = {},
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

  const safeToRemove = await prepareLaneWorktreeRemoval(lane, worktreePath, opts.terminal === true);
  if (!safeToRemove) return false;

  try {
    const manager = getWorktreeManager(lane.repoPath);
    const worktree = (await manager.list()).find((candidate) => candidate.path === worktreePath);
    if (worktree) {
      // manager.cleanup already calls preserveUncommittedWork internally
      await manager.cleanup(worktree.id, { force: true, deleteBranch: opts.deleteBranch ?? true });
      return true;
    }
  } catch (error) {
    console.warn(`[lane-worktree] Manager cleanup failed for ${lane.id}: ${formatError(error)}`);
  }

  return removeCortexWorktreePath({
    repoRoot: lane.repoPath,
    worktreePath,
    laneId: lane.id,
    logPrefix: 'lane-worktree',
  });
}

export async function pruneRepoWorktrees(repoPath: string): Promise<string[]> {
  return getWorktreeManager(repoPath).prune();
}
