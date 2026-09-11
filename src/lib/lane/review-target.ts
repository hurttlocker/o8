import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';

import { isSafeGitRef } from '@/lib/git/refs';
import {
  BRANCH_UNRESOLVED_CODE,
  WORKTREE_MISSING_CODE,
  type LaneReviewTargetErrorCode,
} from './review-target-codes';
import type { Lane } from './types';

export { BRANCH_UNRESOLVED_CODE, WORKTREE_MISSING_CODE, type LaneReviewTargetErrorCode };

export class LaneBranchUnresolvedError extends Error {
  constructor(
    readonly lane: Pick<Lane, 'id' | 'branch' | 'repoPath' | 'worktreePath'>,
    readonly reason: string,
    readonly code: LaneReviewTargetErrorCode = BRANCH_UNRESOLVED_CODE,
  ) {
    super(
      code === WORKTREE_MISSING_CODE
        ? `Lane ${lane.id} ${reason}; there is nothing left on disk to diff.`
        : `Branch unresolved for lane ${lane.id}: recorded branch "${lane.branch}" ${reason}. `
          + `Refusing to fall back to the repo checkout at ${lane.repoPath}.`,
    );
    this.name = 'LaneBranchUnresolvedError';
  }
}

export interface LaneReviewTarget {
  cwd: string;
  branch: string;
}

export interface BranchUnresolvedPayload {
  ok: false;
  error: {
    code: LaneReviewTargetErrorCode;
    message: string;
    laneId: string;
    branch: string;
    worktreePath: string | null;
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    windowsHide: true,
    cwd,
    timeout: 5000,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function worktreeForBranch(repoPath: string, branch: string): string | null {
  const entries = git(repoPath, ['worktree', 'list', '--porcelain']).split('\n\n');
  const expectedRef = `refs/heads/${branch}`;
  for (const entry of entries) {
    const lines = entry.split('\n');
    const worktree = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length).trim();
    const branchRef = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length).trim();
    if (worktree && branchRef === expectedRef) return worktree;
  }
  return null;
}

function validateTarget(lane: Lane, candidatePath: string): LaneReviewTarget {
  if (!existsSync(candidatePath)) {
    throw new LaneBranchUnresolvedError(
      lane,
      `recorded its worktree at ${candidatePath}, and that path is no longer on disk`,
      WORKTREE_MISSING_CODE,
    );
  }

  try {
    const cwd = realpathSync(candidatePath);
    const root = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
    if (root !== cwd) {
      throw new LaneBranchUnresolvedError(lane, `points inside ${root}, not at its worktree root`);
    }
    const actualBranch = git(cwd, ['branch', '--show-current']);
    if (actualBranch !== lane.branch) {
      throw new LaneBranchUnresolvedError(
        lane,
        `resolves to branch "${actualBranch || '(detached)'}" at ${cwd}`,
      );
    }
    return { cwd, branch: actualBranch };
  } catch (error) {
    if (error instanceof LaneBranchUnresolvedError) throw error;
    throw new LaneBranchUnresolvedError(lane, `cannot be verified at ${candidatePath}`);
  }
}

export function resolveLaneReviewTarget(lane: Lane): LaneReviewTarget {
  if (!isSafeGitRef(lane.branch)) {
    throw new LaneBranchUnresolvedError(lane, 'is not a safe Git ref');
  }

  if (lane.worktreePath?.trim()) {
    return validateTarget(lane, lane.worktreePath.trim());
  }

  try {
    const discoveredPath = worktreeForBranch(lane.repoPath, lane.branch);
    if (discoveredPath) return validateTarget(lane, discoveredPath);
    const branchExists = git(lane.repoPath, ['show-ref', '--verify', '--hash', `refs/heads/${lane.branch}`]);
    if (branchExists) {
      throw new LaneBranchUnresolvedError(
        lane,
        `kept branch "${lane.branch}" but no worktree is attached to it any more`,
        WORKTREE_MISSING_CODE,
      );
    }
    throw new LaneBranchUnresolvedError(lane, 'does not exist');
  } catch (error) {
    if (error instanceof LaneBranchUnresolvedError) throw error;
    throw new LaneBranchUnresolvedError(lane, 'does not exist');
  }
}

export function branchUnresolvedPayload(error: LaneBranchUnresolvedError): BranchUnresolvedPayload {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      laneId: error.lane.id,
      branch: error.lane.branch,
      worktreePath: error.lane.worktreePath,
    },
  };
}
