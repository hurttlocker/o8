import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { cleanupLaneWorktree } from '@/lib/lane/worktree-cleanup';
import type { LaneRuntime } from '@/lib/lane/types';
import { runRuntimeAwareWorktreeCleanup } from '@/lib/orchestrator/runtime-worktree-cleanup';
import { releaseTerminalPacketStorageReservations } from '@/lib/orchestrator/terminal-storage-release';
import { formatWorktreeHolderPids } from '@/lib/worktree/holder-diagnostics';

const execFileAsync = promisify(execFile);

export interface ResetCleanupTarget {
  id: string;
  repoPath: string;
  branch: string;
  runtime: LaneRuntime;
  worktreePath: string | null;
  storageAdmissionOwnerGeneration?: number;
  overrideLiveGuard?: true;
}

export interface ResetCleanupResult {
  worktreePruned: boolean;
  branchDeleted: boolean;
}

function normalizeRepoPath(repoPath: string) {
  return repoPath.trim().replace(/\/+$/, '');
}

function sameRepo(left: string, right: string) {
  return normalizeRepoPath(left) === normalizeRepoPath(right);
}

function isTerminalStatus(status: string) {
  return status === 'archived' || status === 'completed';
}

function isDispatchBranch(branch: string) {
  return branch.startsWith('issue/') || branch.startsWith('inline/');
}

async function localBranchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      windowsHide: true,
      cwd: repoPath,
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function deleteLocalBranch(repoPath: string, branch: string): Promise<boolean> {
  if (!isDispatchBranch(branch) || !(await localBranchExists(repoPath, branch))) {
    return false;
  }
  await execFileAsync('git', ['branch', '-D', branch], { windowsHide: true, cwd: repoPath, timeout: 10_000 });
  return true;
}

export async function cleanupResetPacketTargets(
  targets: ResetCleanupTarget[],
  packetId: string,
): Promise<ResetCleanupResult> {
  const targetIds = new Set(targets.map((target) => target.id));
  const groups = new Map<string, ResetCleanupTarget[]>();
  let worktreePruned = false;
  let branchDeleted = false;

  for (const target of targets) {
    if (target.worktreePath) {
      // An already-absent checkout is the cleanup postcondition, not a failure.
      // Skip preservation/prune probes that necessarily require the path to
      // exist; stale lane metadata must remain resettable through this handler.
      if (!existsSync(target.worktreePath)) {
        releaseTerminalPacketStorageReservations({
          packetId,
          laneId: target.id,
          ownerGeneration: target.storageAdmissionOwnerGeneration,
        });
        worktreePruned = true;
      } else {
        // reset is an explicit operator/recovery action — force past the prune
        // gate (records prune_forced) so a non-terminal lane's worktree can be
        // torn down for the restart. The head is banked first (force path).
        const cleanupAttempt = await runRuntimeAwareWorktreeCleanup({
          runtime: target.runtime,
          worktreePath: target.worktreePath,
          cleanup: () => cleanupLaneWorktree({ ...target, packetId }, {
            deleteBranch: false,
            force: true,
            overrideLiveGuard: target.overrideLiveGuard,
          }),
          removed: (removed) => removed || !existsSync(target.worktreePath!),
        });
        const removed = cleanupAttempt.result;
        if (!removed && existsSync(target.worktreePath)) {
          throw new Error(`Worktree cleanup was not confirmed for lane ${target.id} at ${target.worktreePath}.${formatWorktreeHolderPids(cleanupAttempt.holderPids)}`);
        }
        worktreePruned = removed || worktreePruned;
      }
    }
    const key = `${normalizeRepoPath(target.repoPath)}\0${target.branch}`;
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }

  const { appendEvent, listLanes } = await import('@/lib/lane/registry');
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;

    const siblingLanes = listLanes().filter((lane) => (
      !targetIds.has(lane.id)
      && sameRepo(lane.repoPath, first.repoPath)
      && lane.branch === first.branch
      && !isTerminalStatus(lane.status)
    ));

    if (siblingLanes.length > 0) {
      for (const target of group) {
        appendEvent(target.id, 'update', 'system', {
          packetId,
          branch: first.branch,
          branchRetained: true,
          reason: 'sibling_lane_active',
          siblingLaneIds: siblingLanes.map((lane) => lane.id),
        });
      }
      continue;
    }

    branchDeleted = await deleteLocalBranch(first.repoPath, first.branch) || branchDeleted;
  }

  return { worktreePruned, branchDeleted };
}
