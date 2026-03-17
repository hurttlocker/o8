import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReviewChangedFile } from '@/lib/fleet/types';

const execFileAsync = promisify(execFile);
const REVIEW_NOISE_PATHS = new Set(['next-env.d.ts']);

export interface LiveReviewChangeSet {
  repoPath: string;
  workspacePath: string;
  sessionKey?: string;
  changedFiles: ReviewChangedFile[];
  additions: number;
  deletions: number;
  files: number;
}

function isReviewNoisePath(filePath: string) {
  return REVIEW_NOISE_PATHS.has(filePath.trim());
}

function parseChangedFiles(nameStatusRaw: string, numStatRaw: string, untrackedRaw: string) {
  const changed = new Map<string, ReviewChangedFile>();

  for (const line of nameStatusRaw.split('\n').filter(Boolean)) {
    const [statusToken, firstPath, secondPath] = line.split('\t');
    if (!statusToken || !firstPath) continue;

    const status = statusToken[0];
    const reviewPath = status === 'R' && secondPath ? `${firstPath} → ${secondPath}` : secondPath ?? firstPath;
    if (isReviewNoisePath(firstPath) || (secondPath && isReviewNoisePath(secondPath)) || isReviewNoisePath(reviewPath)) {
      continue;
    }

    changed.set(reviewPath, {
      path: reviewPath,
      status:
        status === 'A'
          ? 'added'
          : status === 'D'
            ? 'deleted'
            : status === 'R'
              ? 'renamed'
              : 'modified',
      additions: null,
      deletions: null,
    });
  }

  for (const line of numStatRaw.split('\n').filter(Boolean)) {
    const [additionsRaw, deletionsRaw, filePath] = line.split('\t');
    if (!filePath || isReviewNoisePath(filePath)) continue;

    const entry = changed.get(filePath) ?? {
      path: filePath,
      status: 'modified' as const,
      additions: null,
      deletions: null,
    };

    entry.additions = additionsRaw === '-' ? null : Number.parseInt(additionsRaw ?? '0', 10);
    entry.deletions = deletionsRaw === '-' ? null : Number.parseInt(deletionsRaw ?? '0', 10);
    changed.set(filePath, entry);
  }

  for (const filePath of untrackedRaw.split('\n').map((value) => value.trim()).filter(Boolean)) {
    if (isReviewNoisePath(filePath)) continue;
    changed.set(filePath, {
      path: filePath,
      status: 'untracked',
      additions: null,
      deletions: null,
    });
  }

  return Array.from(changed.values()).sort((left, right) => left.path.localeCompare(right.path));
}

export async function getLiveReviewChangeSet(
  workspacePath: string,
  repoPath = workspacePath,
  sessionKey?: string,
): Promise<LiveReviewChangeSet> {
  const [nameStatusRaw, numStatRaw, untrackedRaw] = await Promise.all([
    execFileAsync('git', ['-C', workspacePath, 'diff', '--name-status', '--relative', '-M', 'HEAD'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }).then((result) => result.stdout).catch(() => ''),
    execFileAsync('git', ['-C', workspacePath, 'diff', '--numstat', '--relative', '-M', 'HEAD'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }).then((result) => result.stdout).catch(() => ''),
    execFileAsync('git', ['-C', workspacePath, 'ls-files', '--others', '--exclude-standard'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }).then((result) => result.stdout).catch(() => ''),
  ]);

  const changedFiles = parseChangedFiles(nameStatusRaw, numStatRaw, untrackedRaw);
  const additions = changedFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = changedFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  return {
    repoPath,
    workspacePath,
    sessionKey,
    changedFiles,
    additions,
    deletions,
    files: changedFiles.length,
  };
}
