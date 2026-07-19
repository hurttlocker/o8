import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { ownedTranscriptMtimeMs } from '@/lib/lane/reaper-liveness';

async function mtimeMs(candidate: string): Promise<number | null> {
  try {
    const value = (await stat(candidate)).mtimeMs;
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function gitAdminPath(worktreePath: string, name: string): Promise<string> {
  const dotGit = path.join(worktreePath, '.git');
  try {
    const raw = await readFile(dotGit, 'utf8');
    const match = raw.match(/^gitdir:\s*(.+)\s*$/m);
    if (match?.[1]) return path.resolve(worktreePath, match[1], name);
  } catch {
    // APFS clones have a real .git directory, not a gitdir pointer file.
  }
  return path.join(dotGit, name);
}

function safeChangedPath(worktreePath: string, relativePath: string): string | null {
  const root = path.resolve(worktreePath);
  const candidate = path.resolve(root, relativePath);
  return candidate.startsWith(`${root}${path.sep}`) ? candidate : null;
}

export interface WorktreeActivityInput {
  worktreePath: string;
  sessionKey?: string;
  changedPaths?: string[];
}

/**
 * Truthful bounded activity signal for retention ordering. Root mtime catches
 * file creation/removal, git-admin mtimes catch commits, changed-file mtimes
 * catch edits, and owned transcripts catch worker output between git writes.
 */
export async function worktreeActivityMtimeMs(input: WorktreeActivityInput): Promise<number> {
  const candidates = [
    input.worktreePath,
    await gitAdminPath(input.worktreePath, 'HEAD'),
    await gitAdminPath(input.worktreePath, 'index'),
    ...(input.changedPaths ?? [])
      .map((changedPath) => safeChangedPath(input.worktreePath, changedPath))
      .filter((candidate): candidate is string => candidate !== null),
  ];
  const [filesystemMtimes, transcriptMtime] = await Promise.all([
    Promise.all(candidates.map(mtimeMs)),
    input.sessionKey
      ? ownedTranscriptMtimeMs(input.sessionKey).catch(() => null)
      : Promise.resolve(null),
  ]);
  const valid = [...filesystemMtimes, transcriptMtime]
    .filter((value): value is number => value !== null && Number.isFinite(value) && value > 0);

  // Unknown activity is never old: fail closed so retention keeps the tree.
  return valid.length > 0 ? Math.max(...valid) : Date.now();
}
