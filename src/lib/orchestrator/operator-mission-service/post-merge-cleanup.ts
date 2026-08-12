import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { recordMergeCleanupEvent } from '@/lib/lane/events';
import { listActiveLanesWithSessions } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { removeCortexWorktreePath } from '@/lib/lane/worktree-clone-removal';

const execFileAsync = promisify(execFile);

type CleanupLane = Pick<
  Lane,
  'id' | 'repoPath' | 'worktreePath' | 'branch' | 'baseBranch' | 'runtime' | 'sessionKey'
>;

export interface PostMergeCleanupTarget extends CleanupLane {
  actualBranch: string | null;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function cortexWorktreeInfo(targetPath: string | null | undefined) {
  if (!targetPath) return null;
  const resolved = path.resolve(targetPath);
  const parts = resolved.split(path.sep);
  const markerIndex = parts.lastIndexOf('.cortex-worktrees');
  if (markerIndex === -1 || markerIndex >= parts.length - 1) return null;
  const repoRoot = parts.slice(0, markerIndex).join(path.sep) || path.sep;
  return { path: resolved, repoRoot };
}

function cleanupRepoRoot(target: PostMergeCleanupTarget) {
  return cortexWorktreeInfo(target.repoPath)?.repoRoot ?? target.repoPath;
}

function candidateWorktreePath(target: PostMergeCleanupTarget) {
  return cortexWorktreeInfo(target.worktreePath)?.path
    ?? cortexWorktreeInfo(target.repoPath)?.path
    ?? null;
}

function branchCandidates(target: PostMergeCleanupTarget) {
  const branches = [target.actualBranch, target.branch]
    .map((branch) => branch?.trim())
    .filter((branch): branch is string => Boolean(branch) && branch !== 'HEAD' && branch !== target.baseBranch);
  return [...new Set(branches)];
}

async function localBranchExists(repoPath: string, branch: string) {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      windowsHide: true,
      cwd: repoPath,
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

async function canInspectBranches(repoPath: string) {
  if (!existsSync(repoPath)) return false;
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], {
      windowsHide: true,
      cwd: repoPath,
      timeout: 5000,
    });
    return true;
  } catch (error) {
    console.warn(`[merge-cleanup] Cannot inspect branches in ${repoPath}: ${formatError(error)}`);
    return false;
  }
}

async function deleteBranch(repoPath: string, branch: string) {
  if (!(await localBranchExists(repoPath, branch))) {
    console.warn(`[merge-cleanup] Branch ${branch} is already absent.`);
    return true;
  }

  try {
    await execFileAsync('git', ['branch', '-d', branch], {
      windowsHide: true,
      cwd: repoPath,
      timeout: 10_000,
    });
    return true;
  } catch (error) {
    if (!(await localBranchExists(repoPath, branch))) {
      return true;
    }
    console.warn(`[merge-cleanup] Failed to delete branch ${branch}: ${formatError(error)}`);
    return false;
  }
}

async function deleteBranches(target: PostMergeCleanupTarget) {
  const branches = branchCandidates(target);
  if (branches.length === 0) {
    console.warn(`[merge-cleanup] No feature branch recorded for lane ${target.id}.`);
    return false;
  }

  const repoRoot = cleanupRepoRoot(target);
  if (!(await canInspectBranches(repoRoot))) {
    return false;
  }
  const outcomes = await Promise.all(branches.map((branch) => deleteBranch(repoRoot, branch)));
  return outcomes.every(Boolean);
}

async function pruneWorktrees(repoRoot: string) {
  try {
    await execFileAsync('git', ['worktree', 'prune'], {
      windowsHide: true,
      cwd: repoRoot,
      timeout: 10_000,
    });
  } catch (error) {
    console.warn(`[merge-cleanup] git worktree prune failed for ${repoRoot}: ${formatError(error)}`);
  }
}

async function removeWorktree(target: PostMergeCleanupTarget) {
  const worktreePath = candidateWorktreePath(target);
  if (!worktreePath) {
    console.warn(`[merge-cleanup] Lane ${target.id} has no .cortex-worktrees path to remove.`);
    return false;
  }

  const repoRoot = cleanupRepoRoot(target);
  if (!existsSync(worktreePath)) {
    console.warn(`[merge-cleanup] Worktree ${worktreePath} is already absent.`);
    await pruneWorktrees(repoRoot);
    return true;
  }

  return removeCortexWorktreePath({
    repoRoot,
    worktreePath,
    laneId: target.id,
    logPrefix: 'merge-cleanup',
  });
}

function sessionIsStillActive(sessionKey: string) {
  try {
    return listActiveLanesWithSessions().some((lane) => lane.sessionKey === sessionKey);
  } catch (error) {
    console.warn(`[merge-cleanup] Failed to check active lanes before session archive: ${formatError(error)}`);
    return true;
  }
}

async function archiveSession(target: PostMergeCleanupTarget) {
  const sessionKey = target.sessionKey?.trim();
  if (!sessionKey) {
    console.warn(`[merge-cleanup] Lane ${target.id} has no owned session to archive.`);
    return false;
  }
  if (sessionIsStillActive(sessionKey)) {
    console.warn(`[merge-cleanup] Session ${sessionKey} is still attached to an active lane; skipping archive.`);
    return false;
  }

  try {
    const { archiveOwnedRuntimeSession } = await import('@/lib/runtime/owned-session-archive');
    return (await archiveOwnedRuntimeSession(sessionKey))?.archived === true;
  } catch (error) {
    console.warn(`[merge-cleanup] Failed to archive session ${sessionKey}: ${formatError(error)}`);
    return false;
  }
}

export async function capturePostMergeCleanupTarget(lane: CleanupLane): Promise<PostMergeCleanupTarget> {
  let actualBranch: string | null = null;
  const worktreePath = lane.worktreePath?.trim();
  if (worktreePath) {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        windowsHide: true,
        cwd: worktreePath,
        timeout: 5000,
      });
      const branch = stdout.trim();
      actualBranch = branch && branch !== 'HEAD' ? branch : null;
    } catch (error) {
      console.warn(`[merge-cleanup] Failed to capture actual branch for lane ${lane.id}: ${formatError(error)}`);
    }
  }

  return { ...lane, actualBranch };
}

export async function postMergeCleanup(target: PostMergeCleanupTarget) {
  let branchDeleted = false;
  let worktreeRemoved = false;
  let sessionArchived = false;

  try {
    branchDeleted = await deleteBranches(target);
  } catch (error) {
    console.warn(`[merge-cleanup] Branch cleanup failed for lane ${target.id}: ${formatError(error)}`);
  }

  try {
    worktreeRemoved = await removeWorktree(target);
  } catch (error) {
    console.warn(`[merge-cleanup] Worktree cleanup failed for lane ${target.id}: ${formatError(error)}`);
  }

  if (!branchDeleted && worktreeRemoved) {
    try {
      branchDeleted = await deleteBranches(target);
    } catch (error) {
      console.warn(`[merge-cleanup] Branch cleanup retry failed for lane ${target.id}: ${formatError(error)}`);
    }
  }

  try {
    sessionArchived = await archiveSession(target);
  } catch (error) {
    console.warn(`[merge-cleanup] Session cleanup failed for lane ${target.id}: ${formatError(error)}`);
  }

  try {
    recordMergeCleanupEvent(target.id, {
      branch_deleted: branchDeleted,
      worktree_removed: worktreeRemoved,
      session_archived: sessionArchived,
    });
  } catch (error) {
    console.warn(`[merge-cleanup] Failed to write audit event for lane ${target.id}: ${formatError(error)}`);
  }
}
