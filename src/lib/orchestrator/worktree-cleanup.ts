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
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { findLaneByPacket } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { allowWorktreeRemoval } from '@/lib/worktree/live-process-guard';

const execFileAsync = promisify(execFile);

export type RemoveMergedWorktreeReason =
  | 'no-worktree-path'
  | 'worktree-equals-repo'
  | 'already-removed'
  | 'dirty'
  | 'remove-failed'
  | 'status-failed';

export interface RemoveMergedWorktreeResult {
  removed: boolean;
  reason?: RemoveMergedWorktreeReason;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isWorktreeDirty(worktreePath: string): Promise<'clean' | 'dirty' | 'unknown'> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
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
): Promise<RemoveMergedWorktreeResult> {
  const worktreePath = lane.worktreePath?.trim();
  if (!worktreePath) {
    return { removed: true, reason: 'no-worktree-path' };
  }

  // Safety guard: never touch the main working tree. An un-isolated lane
  // has worktreePath === repoPath; removing that would destroy the repo.
  const normalizedRepo = lane.repoPath.replace(/\/+$/, '');
  const normalizedWorktree = worktreePath.replace(/\/+$/, '');
  if (normalizedWorktree === normalizedRepo) {
    console.log(
      '[worktree-cleanup]',
      `Skipping cleanup for lane ${lane.id}: worktree path equals repo path (no isolation).`,
    );
    return { removed: false, reason: 'worktree-equals-repo' };
  }

  // Idempotency: if the path is already gone, prune stale metadata and bail.
  if (!(await pathExists(worktreePath))) {
    try {
      await execFileAsync('git', ['worktree', 'prune'], {
        cwd: lane.repoPath,
        timeout: 10_000,
      });
    } catch (error) {
      // Prune is cleanup-of-cleanup; failure is non-fatal.
      console.log(
        '[worktree-cleanup]',
        `Prune failed for ${lane.repoPath}: ${formatError(error)}`,
      );
    }
    return { removed: true, reason: 'already-removed' };
  }

  // Dirty guard: a post-merge worktree should be clean. If it isn't,
  // preserve the work and let the reconcile sweep deal with it rather
  // than force-removing and losing uncommitted changes.
  const cleanliness = await isWorktreeDirty(worktreePath);
  if (cleanliness === 'dirty') {
    console.log(
      '[worktree-cleanup]',
      `Lane ${lane.id} worktree at ${worktreePath} has uncommitted changes — skipping force-remove.`,
    );
    return { removed: false, reason: 'dirty' };
  }
  if (cleanliness === 'unknown') {
    // `git status` failed — the worktree may be corrupt. Fall through to
    // force-remove; if it's truly corrupt we want it gone.
    console.log(
      '[worktree-cleanup]',
      `Lane ${lane.id} worktree status unknown — proceeding with force-remove.`,
    );
  }

  // Force-remove the worktree. Branch may already be deleted by the merge
  // path — `git worktree remove --force` tolerates a missing branch.
  if (!(await allowWorktreeRemoval(worktreePath, { logPrefix: 'worktree-cleanup' }))) {
    return { removed: false, reason: 'remove-failed' };
  }
  try {
    await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: lane.repoPath,
      timeout: 15_000,
    });
  } catch (error) {
    const message = formatError(error);
    // If the directory vanished between our check and the remove, treat
    // that as success — another cleanup path beat us to it.
    if (
      message.includes('is not a working tree')
      || message.includes('not a working tree')
      || message.includes('No such file or directory')
    ) {
      try {
        await execFileAsync('git', ['worktree', 'prune'], {
          cwd: lane.repoPath,
          timeout: 10_000,
        });
      } catch {
        // Already-pruned is fine.
      }
      return { removed: true, reason: 'already-removed' };
    }

    console.log(
      '[worktree-cleanup]',
      `Force-remove failed for lane ${lane.id} at ${worktreePath}: ${message}`,
    );
    return { removed: false, reason: 'remove-failed' };
  }

  // Prune stale worktree list entries so `git worktree list` stays clean.
  try {
    await execFileAsync('git', ['worktree', 'prune'], {
      cwd: lane.repoPath,
      timeout: 10_000,
    });
  } catch (error) {
    console.log(
      '[worktree-cleanup]',
      `Prune after remove failed for ${lane.repoPath}: ${formatError(error)}`,
    );
  }

  return { removed: true };
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
    if (!cleanup.removed) {
      console.log(
        '[worktree-cleanup]',
        `Post-merge cleanup skipped for lane ${preMergeLane.id} (packet ${packetId}): reason=${cleanup.reason ?? 'unknown'}.`,
      );
    }
  }
  return result;
}
