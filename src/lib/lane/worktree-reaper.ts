/**
 * Stale-worktree reaper.
 *
 * Periodically scans lanes stuck in `reviewing` and auto-archives them when:
 *   1. The worktree directory no longer exists on disk (orphaned review), OR
 *   2. The lane's branch tip is already reachable from the base branch
 *      (merged externally — including manual cherry-picks).
 *
 * `archiveLane()` handles the downstream worktree + branch cleanup when the
 * worktreePath is still set, so we just flip the lane via the same code path
 * used by the lane command bus. Anything already cleaned up on disk is a no-op.
 *
 * Lives on its own interval rather than bolting onto `supervisorTick` because
 * it walks *all* lanes, not just watched agents.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { archiveLane, listActiveLanes } from '@/lib/lane/registry';

const execFileAsync = promisify(execFile);

const REAPER_INTERVAL_MS = 5 * 60_000;          // 5 minutes
const STALE_REVIEW_THRESHOLD_MS = 2 * 60 * 60_000; // 2 hours

let reaperTimer: ReturnType<typeof setInterval> | null = null;

async function branchIsMergedIntoBase(
  repoPath: string,
  branch: string,
  baseBranch: string,
): Promise<boolean> {
  try {
    // `git merge-base --is-ancestor <branch> <base>` exits 0 when the branch
    // tip is already reachable from base, 1 when it isn't. Anything else
    // (missing ref, bad repo) throws and we fall through to "not merged".
    await execFileAsync(
      'git',
      ['merge-base', '--is-ancestor', branch, baseBranch],
      { cwd: repoPath, timeout: 5_000 },
    );
    return true;
  } catch {
    return false;
  }
}

export async function runWorktreeReaperTick(): Promise<void> {
  const lanes = listActiveLanes();
  const now = Date.now();

  for (const lane of lanes) {
    if (lane.status !== 'reviewing') continue;

    const updatedAtMs = Date.parse(lane.updatedAt);
    const ageMs = Number.isFinite(updatedAtMs) ? now - updatedAtMs : 0;

    // Case 1: worktreePath stored but the directory is gone on disk.
    // Only trigger after 2h to give legitimate reviews room to breathe.
    if (
      lane.worktreePath
      && !existsSync(lane.worktreePath)
      && ageMs > STALE_REVIEW_THRESHOLD_MS
    ) {
      console.log(`[worktree-reaper] ${lane.id} worktree missing on disk (${Math.round(ageMs / 60_000)}m stale) — archiving`);
      archiveLane(lane.id, 'system');
      continue;
    }

    // Case 2: branch tip already merged into base (common when the operator
    // cherry-picks onto main manually or merges via another workflow).
    // Safe to archive at any age — the work has already landed.
    if (lane.branch && lane.baseBranch) {
      const merged = await branchIsMergedIntoBase(
        lane.repoPath,
        lane.branch,
        lane.baseBranch,
      );
      if (merged) {
        console.log(`[worktree-reaper] ${lane.id} branch ${lane.branch} already in ${lane.baseBranch} — archiving`);
        archiveLane(lane.id, 'system');
      }
    }
  }
}

export function startWorktreeReaper(): void {
  if (reaperTimer) return;

  setTimeout(() => {
    void runWorktreeReaperTick().catch((err) => {
      console.error('[worktree-reaper] initial tick failed:', err);
    });
  }, 30_000);

  reaperTimer = setInterval(() => {
    void runWorktreeReaperTick().catch((err) => {
      console.error('[worktree-reaper] tick failed:', err);
    });
  }, REAPER_INTERVAL_MS);

  console.log(`[worktree-reaper] started (interval ${REAPER_INTERVAL_MS}ms, stale threshold ${STALE_REVIEW_THRESHOLD_MS}ms)`);
}

export function stopWorktreeReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
    console.log('[worktree-reaper] stopped');
  }
}
