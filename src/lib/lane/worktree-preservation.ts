import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { autoCommitCompletionWorktree } from '@/lib/supervisor/completion-verification';
import type { Lane } from './types';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

export interface LaneWorktreePreservation {
  preserved: boolean;
  autoCommitted: boolean;
  branchName?: string;
  refName?: string;
  headSha?: string;
}

function branchSafeId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'lane';
}

async function git(cwd: string, args: string[]) {
  return execFileAsync('git', args, {
    cwd,
    timeout: 30_000,
    maxBuffer: COMMAND_MAX_BUFFER,
  });
}

async function headHasUnmergedWork(worktreePath: string, baseBranch: string): Promise<boolean> {
  try {
    await git(worktreePath, ['merge-base', '--is-ancestor', 'HEAD', baseBranch]);
    return false;
  } catch {
    return true;
  }
}

async function preserveHeadRef(
  repoPath: string,
  worktreePath: string,
  refName: string,
): Promise<void> {
  try {
    await git(repoPath, ['fetch', worktreePath, `+HEAD:${refName}`]);
    return;
  } catch {
    await git(worktreePath, ['update-ref', refName, 'HEAD']);
  }
}

export async function preserveLaneWorktreeHead(
  lane: Pick<Lane, 'id' | 'repoPath' | 'worktreePath' | 'baseBranch'>,
): Promise<LaneWorktreePreservation> {
  const worktreePath = lane.worktreePath?.trim();
  if (!worktreePath) {
    return { preserved: false, autoCommitted: false };
  }

  const autoCommitted = await autoCommitCompletionWorktree(worktreePath);
  const baseBranch = lane.baseBranch?.trim() || 'main';
  const hasUnmergedWork = await headHasUnmergedWork(worktreePath, baseBranch);
  if (!autoCommitted && !hasUnmergedWork) {
    return { preserved: false, autoCommitted: false };
  }

  const id = branchSafeId(path.basename(worktreePath) || lane.id);
  const branchName = `preserved/${id}`;
  const refName = `refs/heads/${branchName}`;
  await preserveHeadRef(lane.repoPath, worktreePath, refName);
  const { stdout } = await git(worktreePath, ['rev-parse', 'HEAD']);

  return {
    preserved: true,
    autoCommitted,
    branchName,
    refName,
    headSha: stdout.trim() || undefined,
  };
}
