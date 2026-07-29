import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isOrchestratorHomePath } from '@/lib/orchestrator/repo-path';

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
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf-8',
      timeout: 5_000,
      maxBuffer: 128 * 1024,
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
