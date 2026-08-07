import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { autoCommitCompletionWorktree } from '@/lib/supervisor/completion-verification';
import type { Lane } from './types';
import { captureWorktreeState } from './worktree-capture';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

export interface LaneWorktreePreservation {
  preserved: boolean;
  autoCommitted: boolean;
  branchName?: string;
  refName?: string;
  headSha?: string;
  /** True when uncommitted work was snapshotted to an out-of-band capture ref
   *  (see captureWorktreeState) — recovery independent of the agent's commit. */
  captured?: boolean;
  captureRef?: string;
}

function branchSafeId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'lane';
}

async function git(cwd: string, args: string[]) {
  return execFileAsync('git', args, {
    windowsHide: true,
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

  // Capture the raw working state to an out-of-band ref BEFORE any commit logic
  // runs, so recovery never depends on the agent (or a blind amend) having
  // committed correctly — the worktree-amend false-landing trap.
  const capture = await captureWorktreeState(worktreePath, lane.id, lane.repoPath);

  const autoCommitted = await autoCommitCompletionWorktree(worktreePath);
  const baseBranch = lane.baseBranch?.trim() || 'main';
  const hasUnmergedWork = await headHasUnmergedWork(worktreePath, baseBranch);
  if (!autoCommitted && !hasUnmergedWork) {
    return {
      preserved: false,
      autoCommitted: false,
      captured: capture.captured,
      captureRef: capture.ref,
    };
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
    captured: capture.captured,
    captureRef: capture.ref,
  };
}
