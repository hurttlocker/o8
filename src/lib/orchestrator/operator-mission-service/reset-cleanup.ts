import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanupLaneWorktree } from '@/lib/lane/worktree-cleanup';

const execFileAsync = promisify(execFile);

export interface ResetCleanupTarget {
  id: string;
  repoPath: string;
  branch: string;
  worktreePath: string | null;
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
  await execFileAsync('git', ['branch', '-D', branch], { cwd: repoPath, timeout: 10_000 });
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
      // reset is an explicit operator/recovery action — force past the prune
      // gate (records prune_forced) so a non-terminal lane's worktree can be
      // torn down for the restart. The head is banked first (force path).
      worktreePruned = await cleanupLaneWorktree(target, {
        deleteBranch: false,
        force: true,
        overrideLiveGuard: target.overrideLiveGuard,
      }) || worktreePruned;
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
