import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

// Fallback identity so `commit-tree` always succeeds even when the worktree has
// no user.name/user.email configured (the capture is o8's, not the agent's).
const CAPTURE_IDENTITY = {
  GIT_AUTHOR_NAME: 'o8-capture',
  GIT_AUTHOR_EMAIL: 'capture@o8.dev',
  GIT_COMMITTER_NAME: 'o8-capture',
  GIT_COMMITTER_EMAIL: 'capture@o8.dev',
} as const;

export interface WorktreeCapture {
  captured: boolean;
  /** `refs/o8-capture/<laneId>` — points at the snapshot commit. */
  ref?: string;
  sha?: string;
}

function captureSafeId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'lane';
}

async function git(cwd: string, args: string[], env?: Record<string, string>) {
  return execFileAsync('git', args, {
    windowsHide: true,
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER,
    env: env ? { ...process.env, ...env } : process.env,
  });
}

async function isDirty(worktreePath: string): Promise<boolean> {
  const { stdout } = await git(worktreePath, ['status', '--porcelain']);
  return stdout.trim().length > 0;
}

/**
 * Snapshot the FULL working state (tracked + untracked) of a worktree to an
 * out-of-band ref, without touching the working tree, index, or stash stack.
 *
 * Decoupled from the agent's own commit discipline on purpose: recovery of a
 * lane's work must never depend on the agent — or a blind `commit --amend` —
 * having committed correctly. That dependency is the worktree-amend
 * false-landing trap (an agent leaves work uncommitted, an amend folds it into
 * the wrong commit, and the run reports a clean landing that never happened).
 *
 * Best-effort: capture is a safety net and never throws into the caller, so it
 * can't block teardown or merge.
 */
export async function captureWorktreeState(
  worktreePath: string | null | undefined,
  laneId: string,
  repoPath?: string | null,
): Promise<WorktreeCapture> {
  const wt = worktreePath?.trim();
  if (!wt) return { captured: false };

  try {
    if (!(await isDirty(wt))) return { captured: false };

    // Throwaway index so `git add -A` never mutates the real index.
    const tmpIndexDir = mkdtempSync(path.join(tmpdir(), 'o8-capture-'));
    const env = { ...CAPTURE_IDENTITY, GIT_INDEX_FILE: path.join(tmpIndexDir, 'index') };

    let sha = '';
    try {
      await git(wt, ['add', '-A'], env);
      const tree = (await git(wt, ['write-tree'], env)).stdout.trim();
      if (!tree) return { captured: false };

      // Parent on HEAD when it exists; fresh repos with no commits capture as a
      // root commit instead of failing.
      let parentArgs: string[] = [];
      try {
        const head = (await git(wt, ['rev-parse', 'HEAD'])).stdout.trim();
        if (head) parentArgs = ['-p', head];
      } catch {
        // no HEAD yet
      }

      sha = (
        await git(wt, ['commit-tree', tree, ...parentArgs, '-m', `o8-capture: ${laneId}`], env)
      ).stdout.trim();
    } finally {
      rmSync(tmpIndexDir, { recursive: true, force: true });
    }
    if (!sha) return { captured: false };

    const ref = `refs/o8-capture/${captureSafeId(laneId)}`;
    await git(wt, ['update-ref', ref, sha]);

    // Bank the ref into the main repo when the worktree is a CLONE
    // (apfs-cow-clone isolation): the clone's refs die with rmSync at teardown,
    // and teardown is exactly when this snapshot matters. Mirrors
    // preserveHeadRef's fetch-from-clone pattern. Best-effort — an in-clone
    // capture is still better than none.
    const repo = repoPath?.trim();
    if (repo && path.resolve(repo) !== path.resolve(wt)) {
      try {
        await git(repo, ['fetch', wt, `+${ref}:${ref}`]);
      } catch (error) {
        console.warn(
          `[worktree-capture] Could not bank ${ref} into ${repo}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { captured: true, ref, sha };
  } catch (error) {
    console.warn(
      `[worktree-capture] Failed to capture ${wt}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { captured: false };
  }
}
