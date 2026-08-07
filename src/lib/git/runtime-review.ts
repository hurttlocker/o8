import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReviewChangedFile } from '@/lib/fleet/types';
import { parseRecentCommits } from '@/lib/git/recent-commits';

const execFileAsync = promisify(execFile);
const REVIEW_NOISE_PATHS = new Set(['next-env.d.ts']);
// o8's own machinery living inside the repo — never part of "your changes".
const REVIEW_NOISE_PREFIXES = ['.cortex-worktrees/'];

async function tryGit(repoPath: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

function isReviewNoisePath(reviewPath: string) {
  const trimmed = reviewPath.trim();
  if (REVIEW_NOISE_PATHS.has(trimmed)) return true;
  return REVIEW_NOISE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
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
    const [additionsRaw, deletionsRaw, reviewPath] = line.split('\t');
    if (!reviewPath || isReviewNoisePath(reviewPath)) continue;

    const entry = changed.get(reviewPath) ?? {
      path: reviewPath,
      status: 'modified' as const,
      additions: null,
      deletions: null,
    };

    entry.additions = additionsRaw === '-' ? null : Number.parseInt(additionsRaw ?? '0', 10);
    entry.deletions = deletionsRaw === '-' ? null : Number.parseInt(deletionsRaw ?? '0', 10);
    changed.set(reviewPath, entry);
  }

  for (const reviewPath of untrackedRaw.split('\n').map((value) => value.trim()).filter(Boolean)) {
    if (isReviewNoisePath(reviewPath)) continue;
    changed.set(reviewPath, {
      path: reviewPath,
      status: 'untracked',
      additions: null,
      deletions: null,
    });
  }

  return Array.from(changed.values());
}

function summarizeLocalDiff(changedFiles: ReviewChangedFile[], diffStatRaw: string) {
  const untrackedFiles = changedFiles.filter((file) => file.status === 'untracked');
  const trackedSummary = diffStatRaw.trim();

  if (!untrackedFiles.length) {
    return trackedSummary || 'Working tree changed, but git diff --stat returned no visible summary.';
  }

  const lines = trackedSummary ? trackedSummary.split('\n') : [];
  lines.push(`untracked: ${untrackedFiles.length} file${untrackedFiles.length === 1 ? '' : 's'}`);
  lines.push(`total review files: ${changedFiles.length}`);
  return lines.join('\n');
}

export async function getRuntimeRepoReview(repoPath: string) {
  const [branch, head, nameStatusRaw, numStatRaw, untrackedRaw, diffStatRaw, recentCommitsRaw] = await Promise.all([
    tryGit(repoPath, ['branch', '--show-current']),
    tryGit(repoPath, ['rev-parse', '--short', 'HEAD']),
    tryGit(repoPath, ['diff', '--name-status', '--relative', '-M', 'HEAD']),
    tryGit(repoPath, ['diff', '--numstat', '--relative', '-M', 'HEAD']),
    tryGit(repoPath, ['ls-files', '--others', '--exclude-standard']),
    tryGit(repoPath, ['diff', '--stat=120', '--relative', 'HEAD']),
    tryGit(repoPath, ['log', '--format=%H%x09%h%x09%s', '-8']),
  ]);

  const changedFiles = parseChangedFiles(nameStatusRaw, numStatRaw, untrackedRaw);
  const recentCommits = recentCommitsRaw ? parseRecentCommits(recentCommitsRaw) : [];

  return {
    branch: branch || undefined,
    head: head || undefined,
    dirty: changedFiles.length > 0,
    changedFiles,
    diffStat: changedFiles.length ? summarizeLocalDiff(changedFiles, diffStatRaw) : 'Working tree clean.',
    recentCommits,
  };
}
