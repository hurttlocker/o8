/**
 * Stale-worktree reaper.
 *
 * Periodically scans lanes and auto-archives them when:
 *   1. `reviewing` lane whose worktree directory no longer exists on disk
 *      AND the review has been stale for 2h+ (orphaned review), OR
 *   2. Any active lane whose branch tip is already reachable from the
 *      base branch (merged externally — cherry-picks, outside merges), OR
 *   3. `idle` / `paused` lane that has no diff against its base branch and
 *      hasn't seen activity in 8h+ (abandoned scratch — nothing to review,
 *      no one is watching). Skipped when a pending approval is attached.
 *
 * `archiveLane()` handles the downstream worktree + branch cleanup when the
 * worktreePath is still set, so we just flip the lane via the same code
 * path used by the lane command bus. Anything already cleaned up on disk
 * is a no-op.
 *
 * Lives on its own interval rather than bolting onto `supervisorTick`
 * because it walks *all* lanes, not just watched agents.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { archiveLane, listActiveLanes } from '@/lib/lane/registry';

const execFileAsync = promisify(execFile);

const REAPER_INTERVAL_MS = 5 * 60_000;              // 5 minutes
const STALE_REVIEW_THRESHOLD_MS = 2 * 60 * 60_000;  // 2 hours
const ABANDONED_IDLE_THRESHOLD_MS = 8 * 60 * 60_000; // 8 hours

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

async function worktreeHasNoDiffAgainstBase(
  worktreeCwd: string,
  baseBranch: string,
): Promise<boolean> {
  try {
    // `git diff --quiet <base>...HEAD` exits 0 when there are no differences,
    // 1 when there are. Any other non-zero code (missing ref, detached
    // state) also throws; we conservatively return false so we never archive
    // a lane we can't reason about.
    await execFileAsync(
      'git',
      ['diff', '--quiet', `${baseBranch}...HEAD`],
      { cwd: worktreeCwd, timeout: 5_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function laneHasPendingApproval(laneId: string): Promise<boolean> {
  try {
    const { listApprovalsForContext } = await import('@/lib/approvals/store');
    const approvals = listApprovalsForContext({ laneId });
    return approvals.some((approval) => approval.status === 'pending');
  } catch {
    // If the approvals store is unavailable for any reason, be conservative
    // and treat it as "pending approval present" so we don't archive a lane
    // the operator is actively reviewing.
    return true;
  }
}

export async function runWorktreeReaperTick(): Promise<void> {
  const lanes = listActiveLanes();
  const now = Date.now();

  for (const lane of lanes) {
    const updatedAtMs = Date.parse(lane.updatedAt);
    const ageMs = Number.isFinite(updatedAtMs) ? now - updatedAtMs : 0;

    // Case 1: reviewing lane whose worktree vanished on disk.
    // Only trigger after 2h to give legitimate reviews room to breathe.
    if (
      lane.status === 'reviewing'
      && lane.worktreePath
      && !existsSync(lane.worktreePath)
      && ageMs > STALE_REVIEW_THRESHOLD_MS
    ) {
      console.log(`[worktree-reaper] ${lane.id} worktree missing on disk (${Math.round(ageMs / 60_000)}m stale) — archiving`);
      archiveLane(lane.id, 'system');
      continue;
    }

    // Case 2: branch tip already merged into base (common when the operator
    // cherry-picks onto main manually or merges via another workflow).
    // Safe to archive at any lane age — the work has already landed.
    // Applies to all active statuses so paused/idle lanes whose work
    // shipped via another path also retire cleanly. Gated on
    // `branch !== baseBranch` so un-isolated lanes (session running on the
    // base branch directly) don't trivially trip the merge check.
    if (lane.branch && lane.baseBranch && lane.branch !== lane.baseBranch) {
      const merged = await branchIsMergedIntoBase(
        lane.repoPath,
        lane.branch,
        lane.baseBranch,
      );
      if (merged) {
        console.log(`[worktree-reaper] ${lane.id} branch ${lane.branch} already in ${lane.baseBranch} — archiving`);
        archiveLane(lane.id, 'system');
        continue;
      }
    }

    // Case 3: idle / paused lane with nothing to review. If the worktree has
    // no diff against its base branch AND the lane hasn't seen activity in
    // 8h+, treat it as abandoned and retire it. Skips lanes with pending
    // approvals so in-flight review work never disappears.
    const isEligibleForIdleReap = (lane.status === 'idle' || lane.status === 'paused')
      && ageMs > ABANDONED_IDLE_THRESHOLD_MS;
    if (isEligibleForIdleReap && lane.worktreePath && existsSync(lane.worktreePath) && lane.baseBranch) {
      const approvalPending = await laneHasPendingApproval(lane.id);
      if (approvalPending) continue;

      const noDiff = await worktreeHasNoDiffAgainstBase(lane.worktreePath, lane.baseBranch);
      if (noDiff) {
        console.log(`[worktree-reaper] ${lane.id} idle ${Math.round(ageMs / 3_600_000)}h with no diff against ${lane.baseBranch} — archiving`);
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

  console.log(`[worktree-reaper] started (interval ${REAPER_INTERVAL_MS}ms, stale review ${STALE_REVIEW_THRESHOLD_MS}ms, idle ${ABANDONED_IDLE_THRESHOLD_MS}ms)`);
}

export function stopWorktreeReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
    console.log('[worktree-reaper] stopped');
  }
}
