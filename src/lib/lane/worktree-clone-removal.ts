import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function pruneWorktrees(repoRoot: string, logPrefix: string) {
  try {
    await execFileAsync('git', ['worktree', 'prune'], {
      cwd: repoRoot,
      timeout: 10_000,
    });
  } catch (error) {
    console.warn(`[${logPrefix}] git worktree prune failed for ${repoRoot}: ${formatError(error)}`);
  }
}

export async function removeCortexWorktreePath(input: {
  repoRoot: string;
  worktreePath: string;
  laneId?: string;
  logPrefix?: string;
}): Promise<boolean> {
  const logPrefix = input.logPrefix ?? 'lane-worktree';
  const label = input.laneId ? ` for lane ${input.laneId}` : '';

  if (!existsSync(input.worktreePath)) {
    console.warn(`[${logPrefix}] Worktree ${input.worktreePath}${label} is already absent.`);
    await pruneWorktrees(input.repoRoot, logPrefix);
    return true;
  }

  try {
    await execFileAsync('git', ['worktree', 'remove', '--force', input.worktreePath], {
      cwd: input.repoRoot,
      timeout: 15_000,
    });
    await pruneWorktrees(input.repoRoot, logPrefix);
    return true;
  } catch (error) {
    console.warn(`[${logPrefix}] git worktree remove failed for ${input.worktreePath}: ${formatError(error)}`);
  }

  try {
    rmSync(input.worktreePath, { recursive: true, force: true });
    await pruneWorktrees(input.repoRoot, logPrefix);
    return !existsSync(input.worktreePath);
  } catch (error) {
    console.warn(`[${logPrefix}] fs.rmSync fallback failed for ${input.worktreePath}: ${formatError(error)}`);
    return false;
  }
}
