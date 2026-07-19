import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';

const execFileAsync = promisify(execFile);

function formatExecFailure(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const stderr = 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '').trim() : '';
  const stdout = 'stdout' in error ? String((error as { stdout?: unknown }).stdout ?? '').trim() : '';

  return stderr || stdout || error.message;
}

export async function fetchWorkerBranch(
  repoPath: string,
  remoteBranch: string,
  runId: string,
): Promise<
  | { ok: true; tempWorktreePath: string; baseRef: string }
  | { ok: false; note: string }
> {
  const tempWorktreePath = join(resolveWorktreeRootLayout(repoPath).primaryBase, `remote-merge-${runId}`);
  const baseRef = `origin/${remoteBranch}`;

  try {
    await mkdir(dirname(tempWorktreePath), { recursive: true });
    await execFileAsync('git', ['worktree', 'remove', '--force', tempWorktreePath], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    }).catch(() => {});
    await rm(tempWorktreePath, { recursive: true, force: true });

    await execFileAsync('git', ['fetch', 'origin', remoteBranch], {
      cwd: repoPath,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
    });
    const resolvedBaseRef = (await execFileAsync('git', ['rev-parse', '--verify', baseRef], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    })).stdout.trim();
    await execFileAsync('git', ['worktree', 'add', '--force', '-B', remoteBranch, tempWorktreePath, resolvedBaseRef], {
      cwd: repoPath,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
    });

    return {
      ok: true,
      tempWorktreePath,
      baseRef: resolvedBaseRef,
    };
  } catch (error) {
    return {
      ok: false,
      note: `Failed to fetch remote branch ${remoteBranch}: ${formatExecFailure(error)}`,
    };
  }
}

export async function cleanupRemoteMergeWorktree(repoPath: string, tempWorktreePath: string): Promise<void> {
  try {
    await execFileAsync('git', ['worktree', 'remove', '--force', tempWorktreePath], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
  } finally {
    await rm(tempWorktreePath, { recursive: true, force: true });
  }
}
