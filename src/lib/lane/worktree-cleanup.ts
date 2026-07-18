import { getWorktreeManager } from '@/lib/worktree/launch';
import { preserveLaneWorktreeHead } from './worktree-preservation';
import { removeCortexWorktreePath } from './worktree-clone-removal';
import { checkPruneGate } from './prune-gate';
import type { Lane } from './types';

type CleanupLane = Pick<Lane, 'id' | 'repoPath' | 'worktreePath'> & Partial<Pick<Lane, 'baseBranch'>>;

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bank the worktree HEAD as a salvage branch ref before any destructive step,
 * so a terminal/forced removal never drops a recoverable branch. Best-effort.
 */
async function preserveHeadBeforeRemoval(lane: CleanupLane, worktreePath: string): Promise<void> {
  try {
    await preserveLaneWorktreeHead({
      id: lane.id,
      repoPath: lane.repoPath,
      worktreePath,
      baseBranch: lane.baseBranch ?? 'main',
    });
  } catch (error) {
    console.warn(`[lane-worktree] Failed to preserve head for ${lane.id} before removal (${formatError(error)}).`);
  }
}

export async function cleanupLaneWorktree(
  lane: CleanupLane,
  opts: { deleteBranch?: boolean; terminal?: boolean; force?: boolean; overrideLiveGuard?: true } = {},
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

  const terminal = opts.terminal === true;
  const force = opts.force === true;

  // Bank the head branch ref before any destructive step. manager.cleanup also
  // preserves uncommitted work internally; this covers the commit history.
  if (terminal || force) {
    await preserveHeadBeforeRemoval(lane, worktreePath);
  }

  // Single prune gate (Rock 1 item 3): a terminal owning lane passes cleanly; a
  // non-terminal lane with uncommitted work / recent activity is refused unless
  // the caller explicitly forces (reset/recovery), which records `prune_forced`.
  const gate = await checkPruneGate({
    repoRoot: lane.repoPath,
    worktreePath,
    laneId: lane.id,
    logPrefix: 'lane-worktree',
    operatorForce: force,
  });
  if (!gate.ok) {
    console.warn(`[lane-worktree] Skipping cleanup for ${lane.id}: prune gate refused (${gate.reason}).`);
    return false;
  }

  try {
    const manager = getWorktreeManager(lane.repoPath);
    const worktree = (await manager.list()).find((candidate) => candidate.path === worktreePath);
    if (worktree) {
      // manager.cleanup already calls preserveUncommittedWork internally
      return manager.cleanup(worktree.id, {
        force: true,
        deleteBranch: opts.deleteBranch ?? true,
        overrideLiveGuard: opts.overrideLiveGuard,
      });
    }
  } catch (error) {
    console.warn(`[lane-worktree] Manager cleanup failed for ${lane.id}: ${formatError(error)}`);
  }

  return removeCortexWorktreePath({
    repoRoot: lane.repoPath,
    worktreePath,
    laneId: lane.id,
    logPrefix: 'lane-worktree',
    // Already gated above — don't double-gate (avoids a duplicate prune_forced).
    skipPruneGate: true,
    overrideLiveGuard: opts.overrideLiveGuard,
  });
}

export async function pruneRepoWorktrees(repoPath: string): Promise<string[]> {
  return getWorktreeManager(repoPath).prune();
}
