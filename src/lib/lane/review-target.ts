import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';

import { isSafeGitRef } from '@/lib/git/refs';
import type { Lane } from './types';

export const BRANCH_UNRESOLVED_CODE = 'branch_unresolved' as const;

export class LaneBranchUnresolvedError extends Error {
  readonly code = BRANCH_UNRESOLVED_CODE;

  constructor(
    readonly lane: Pick<Lane, 'id' | 'branch' | 'repoPath' | 'worktreePath'>,
    readonly reason: string,
  ) {
    super(
      `Branch unresolved for lane ${lane.id}: recorded branch "${lane.branch}" ${reason}. `
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
    code: typeof BRANCH_UNRESOLVED_CODE;
    message: string;
    laneId: string;
    branch: string;
    worktreePath: string | null;
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
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
    throw new LaneBranchUnresolvedError(lane, `points to missing worktree ${candidatePath}`);
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
    throw new LaneBranchUnresolvedError(
      lane,
      branchExists ? 'has no attached worktree' : 'does not exist',
    );
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
