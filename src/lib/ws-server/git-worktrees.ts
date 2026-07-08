/**
 * Git worktree parsing helpers for the ws-server review watcher.
 *
 * Pure string/path helpers extracted from the ws-server monolith. No shared
 * state. Faithful move — no behavior change.
 */

import { homedir } from 'node:os';

export type GitWorktreeRecord = {
  path: string;
  branch: string | null;
};

/** Collapse an absolute path under $HOME to a leading `~/`. */
export function shortHome(filePath: string): string {
  const home = process.env.HOME ?? homedir();
  return filePath.startsWith(`${home}/`) ? filePath.replace(`${home}/`, '~/') : filePath;
}

/** Parse `git worktree list --porcelain` output into path/branch records. */
export function parseGitWorktreeList(raw: string): GitWorktreeRecord[] {
  const worktrees: GitWorktreeRecord[] = [];
  let current: GitWorktreeRecord | null = null;

  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null };
      worktrees.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }

  return worktrees;
}
