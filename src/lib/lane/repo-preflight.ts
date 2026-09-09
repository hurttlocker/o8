import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isOrchestratorHomePath } from '@/lib/orchestrator/repo-path';

function couldContainGitWorkTree(repoPath: string): boolean {
  // Explicit Git environment may locate metadata outside the cwd ancestry.
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return true;
  try {
    let directory = realpathSync(repoPath);
    for (;;) {
      if (existsSync(join(directory, '.git'))
        || (existsSync(join(directory, 'HEAD')) && existsSync(join(directory, 'objects')))) return true;
      const parent = dirname(directory);
      if (parent === directory) return false;
      directory = parent;
    }
  } catch {
    return true; // An uncertain filesystem probe still gets Git's verdict.
  }
}

/**
 * #1551 — repo-path preflight shared by BOTH orchestrator spawn paths.
 *
 * Node's spawn throws ENOENT when the WORKING DIRECTORY is missing, but its
 * message names the BINARY — "spawn …/claude ENOENT" — which sent a whole
 * debugging round chasing a healthy install while the real fault was a repo
 * folder the operator had moved or deleted (Sydney, FKAR3B/6JWBVV 2026-07-17).
 * And a plain non-git folder let the CLI boot and fail into a confusing
 * tool-side error mid-turn. Fail with the truth, before any spawn work.
 */
export function isGitWorkTreeSync(repoPath: string): boolean {
  // #2048 — probe the path BEFORE spawning git. A packet whose repo folder was
  // moved or deleted made the headless recovery tick re-run this every tick, and
  // execFileSync inherits the parent's stderr by default, so each miss printed a
  // bare `fatal: not a git repository` into serve.log with nothing naming the
  // caller. The existence check answers the missing-folder case without a spawn;
  // the explicit `stdio` keeps git's stderr piped (and discarded) for the
  // folder-exists-but-isn't-a-repo case, which the catch below already handles.
  if (!repoPath || !existsSync(repoPath)) return false;
  // Queued non-repository folders are checked on every recovery tick. A fresh
  // metadata check avoids spawning Git for them and detects a later git init.
  if (!couldContainGitWorkTree(repoPath)) return false;
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree'], {
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() === 'true';
  } catch {
    return false;
  }
}

/** Throws a human-actionable error when `repoPath` is missing or not a Git
 *  work tree. A null/empty repoPath passes — some sessions run unbound. */
export function assertOrchestratorRepoPath(repoPath: string | null | undefined): void {
  if (!repoPath) return;
  if (!existsSync(repoPath)) {
    throw new Error(
      `This chat's repo folder no longer exists at ${repoPath} — it may have been moved or deleted. `
      + 'Re-add the repo (or point its project at the new location in Settings → Projects), then start a new session.',
    );
  }
  if (isOrchestratorHomePath(repoPath)) return;
  if (!isGitWorkTreeSync(repoPath)) {
    throw new Error(
      `${repoPath} isn't a Git repository — run "git init" there (or point this chat at a Git repo), then try again.`,
    );
  }
}
