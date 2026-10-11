/**
 * Synchronous worktree cleanup for merged lanes.
 *
 * This helper is the single point of truth for removing a merged lane's
 * worktree directory. It is invoked from every merge path (verb=merge
 * governance, bash-merge fallback, MCP approve_and_merge) so the cleanup
 * is synchronous with the merge commit — the agent can dispatch the next
 * packet to a freshly-clean repo without waiting for the reconcile sweep
 * (#541).
 *
 * Contract:
 *   - NEVER throws. All failures are logged and returned as
 *     `{ removed: false, reason }` so callers can continue the merge flow.
 *   - Idempotent: safe to call repeatedly on the same lane. A second call
 *     after the worktree is already gone returns `{ removed: true,
 *     reason: 'already-removed' }` instead of failing.
 *   - Dirty-safe: worktrees with uncommitted changes are NOT force-removed.
 *     The function returns `{ removed: false, reason: 'dirty' }` and leaves
 *     the reconcile sweep to handle the edge case. A post-merge worktree
 *     should never be dirty, but if it is we preserve the work rather
 *     than silently discarding it.
 *
 * See #622.
 */

import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { appendEvent, findLaneByPacket, getLane } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import { getWorktreeManager } from '@/lib/worktree/launch';
import { canonicalRepoRoot } from '@/lib/worktree/root-layout';
import { listWorkspaceSnapshotsByOriginalPath } from '@/lib/worktree/snapshot-state';
import { readManagedWorkspaceMaterialization } from '@/lib/workspace/managed-materialization-identity';
import { getWorkspaceRetirementAction } from '@/lib/workspace/workspace-materialization-retirement';

const execFileAsync = promisify(execFile);

export type RemoveMergedWorktreeReason =
  | 'no-worktree-path'
  | 'worktree-equals-repo'
  | 'already-removed'
  | 'dirty'
  | 'remove-failed'
  | 'status-failed'
  | 'ownership-unavailable'
  | 'retirement-refused'
  // The live-process guard refused removal (#2493): a process is inside, or
  // the probe could not tell. The worktree stays for the reconcile sweep.
  | 'live-process'
  | 'inconclusive';

export interface RemoveMergedWorktreeResult {
  removed: boolean;
  reason?: RemoveMergedWorktreeReason;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function isWorktreeDirty(worktreePath: string): Promise<'clean' | 'dirty' | 'unknown'> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      windowsHide: true,
      cwd: worktreePath,
      timeout: 5000,
    });
    return stdout.trim().length > 0 ? 'dirty' : 'clean';
  } catch (error) {
    console.log(
      '[worktree-cleanup]',
      `git status failed for ${worktreePath}: ${formatError(error)}`,
    );
    return 'unknown';
  }
}

/**
 * Remove the worktree directory for a merged lane.
 *
 * Expected to be called AFTER the merge has committed and BEFORE the
 * lane's lifecycle event fires `state: merged`. See #622.
 */
export async function removeMergedWorktree(
  lane: Pick<Lane, 'id' | 'repoPath' | 'worktreePath'>,
  options: { preserveUncommittedSource?: true } = {},
): Promise<RemoveMergedWorktreeResult> {
  const worktreePath = lane.worktreePath?.trim();
  if (!worktreePath) {
    return { removed: true, reason: 'no-worktree-path' };
  }

  // Safety guard: never touch the main working tree. An un-isolated lane
  // has worktreePath === repoPath; removing that would destroy the repo.
  const normalizedRepo = canonicalRepoRoot(lane.repoPath);
  const normalizedWorktree = path.resolve(worktreePath);
  if (normalizedWorktree === normalizedRepo) {
    console.log(
      '[worktree-cleanup]',
      `Skipping cleanup for lane ${lane.id}: worktree path equals repo path (no isolation).`,
    );
    return { removed: false, reason: 'worktree-equals-repo' };
  }

  try {
    const currentLane = getLane(lane.id);
    const repo = await findRepoByLocalPath(normalizedRepo);
    if (!repo || !currentLane?.packetId
      || canonicalRepoRoot(currentLane.repoPath) !== normalizedRepo) {
      return { removed: false, reason: 'ownership-unavailable' };
    }
    // A captured pre-merge lane is only a locator. Replay success requires
    // durable terminal truth for this exact packet plus confirmed absence.
    if (!(await pathExists(worktreePath))) {
      const snapshots = listWorkspaceSnapshotsByOriginalPath(normalizedWorktree);
      const snapshot = snapshots.length === 1 ? snapshots[0] : null;
      const retired = snapshot?.state === 'retired' && snapshot.repositoryUuid === repo.id
        && snapshot.packetId === currentLane.packetId && snapshot.laneId === currentLane.id;
      return retired ? { removed: true, reason: 'already-removed' }
        : { removed: false, reason: 'ownership-unavailable' };
    }
    if (!currentLane.worktreePath || path.resolve(currentLane.worktreePath) !== normalizedWorktree) {
      return { removed: false, reason: 'ownership-unavailable' };
    }
    const managed = await readManagedWorkspaceMaterialization(normalizedRepo, normalizedWorktree);
    if (!currentLane.sessionKey || managed.metadata.sessionKey !== currentLane.sessionKey) {
      return { removed: false, reason: 'ownership-unavailable' };
    }

    // Post-merge callers require clean source. Explicit unmerged Close uses
    // the manager's exact-owner preservation boundary to bank source first.
    const cleanliness = await isWorktreeDirty(worktreePath);
    if (cleanliness === 'dirty' && options.preserveUncommittedSource !== true) {
      console.log(
        '[worktree-cleanup]',
        `Lane ${lane.id} worktree at ${worktreePath} has uncommitted changes — skipping force-remove.`,
      );
      return { removed: false, reason: 'dirty' };
    }
    if (cleanliness === 'unknown') {
      return { removed: false, reason: 'status-failed' };
    }

    const removed = await getWorktreeManager(normalizedRepo).cleanup(managed.metadata.id, {
      force: true,
      deleteBranch: false,
      workspaceRetirementAction: getWorkspaceRetirementAction(normalizedWorktree) ?? 'cleanup',
    });
    return removed ? { removed: true } : { removed: false, reason: 'retirement-refused' };
  } catch (error) {
    console.warn(`[worktree-cleanup] Retirement refused for lane ${lane.id}: ${formatError(error)}`);
    return { removed: false, reason: 'ownership-unavailable' };
  }
}

/**
 * Record a post-merge cleanup that kept the worktree (#2493). The merge has
 * already succeeded; this only leaves an audit row with the reason so the
 * skipped removal is visible on the lane, and the reconcile sweep removes the
 * worktree later. Never throws.
 */
export function recordSkippedMergeCleanup(
  lane: Pick<Lane, 'id' | 'worktreePath'>,
  packetId: string,
  cleanup: RemoveMergedWorktreeResult,
): void {
  const reason = cleanup.reason ?? 'unknown';
  console.log(
    '[worktree-cleanup]',
    `Post-merge cleanup skipped for lane ${lane.id} (packet ${packetId}): reason=${reason}. Reconcile sweep will handle it.`,
  );
  try {
    appendEvent(lane.id, 'update', 'system', {
      phase: 'merge_cleanup_skipped',
      reason,
      worktreePath: lane.worktreePath ?? null,
    });
  } catch (error) {
    console.log(
      '[worktree-cleanup]',
      `Failed to record skipped cleanup for lane ${lane.id}: ${formatError(error)}`,
    );
  }
}

/**
 * Run an async merge function with a guaranteed synchronous worktree
 * cleanup at the tail. The lane is captured BEFORE the merge so the
 * cleanup call still sees the worktreePath — the merge transaction
 * clears that field on success and a post-merge lookup would miss it.
 *
 * Used at the MCP approve_and_merge boundary so the JSON-RPC client
 * sees a clean working tree the moment control returns.
 */
export async function withSynchronousWorktreeCleanup<T>(
  packetId: string,
  merge: () => Promise<T>,
): Promise<T> {
  const preMergeLane = findLaneByPacket(packetId);
  const result = await merge();
  const mergedFlag = (result as { merged?: unknown } | null | undefined)?.merged;
  if (mergedFlag === true && preMergeLane) {
    const cleanup = await removeMergedWorktree(preMergeLane);
    if (!cleanup.removed) recordSkippedMergeCleanup(preMergeLane, packetId, cleanup);
  }
  return result;
}
