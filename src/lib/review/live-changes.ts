import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ReviewChangedFile } from '@/lib/fleet/types';

const execFileAsync = promisify(execFile);
const REVIEW_NOISE_PATHS = new Set(['next-env.d.ts']);
// o8's own machinery living inside the repo — never part of "your changes".
const REVIEW_NOISE_PREFIXES = ['.cortex-worktrees/'];
const REVIEW_SCAN_SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.cortex-worktrees',
  'node_modules',
  'dist',
  'out',
  'coverage',
]);
const liveReviewChangeCache = new Map<string, { token: string; changeSet: LiveReviewChangeSet }>();

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
  const trimmed = filePath.trim();
  if (REVIEW_NOISE_PATHS.has(trimmed)) return true;
  return REVIEW_NOISE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function safeMtimeMs(filePath: string) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function resolveGitDir(workspacePath: string) {
  const dotGitPath = join(workspacePath, '.git');
  try {
    const dotGitStat = statSync(dotGitPath);
    if (dotGitStat.isDirectory()) return dotGitPath;
    if (!dotGitStat.isFile()) return null;
    const raw = readFileSync(dotGitPath, 'utf-8').trim();
    const match = raw.match(/^gitdir:\s*(.+)$/i);
    if (!match) return null;
    return resolve(workspacePath, match[1]);
  } catch {
    return null;
  }
}

function commonGitDir(gitDir: string) {
  try {
    const raw = readFileSync(join(gitDir, 'commondir'), 'utf-8').trim();
    return isAbsolute(raw) ? raw : resolve(gitDir, raw);
  } catch {
    return gitDir;
  }
}

function headRefPath(gitDir: string, commonDir: string) {
  try {
    const headPath = join(gitDir, 'HEAD');
    const raw = readFileSync(headPath, 'utf-8').trim();
    const match = raw.match(/^ref:\s*(.+)$/);
    if (!match) return null;
    const refPath = match[1];
    return isAbsolute(refPath) ? refPath : join(commonDir, refPath);
  } catch {
    return null;
  }
}

function workingTreeMtimeToken(workspacePath: string) {
  let newest = 0;
  let files = 0;
  const stack = [workspacePath];

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (REVIEW_SCAN_SKIP_DIRS.has(entry.name)) continue;
        stack.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const absPath = join(dir, entry.name);
      const relativePath = absPath.slice(workspacePath.length + 1);
      if (isReviewNoisePath(relativePath)) continue;
      newest = Math.max(newest, safeMtimeMs(absPath));
      files += 1;
    }
  }

  return `${files}:${newest}`;
}

function reviewMtimeToken(workspacePath: string) {
  const gitDir = resolveGitDir(workspacePath);
  if (!gitDir) return `nogit:${workingTreeMtimeToken(workspacePath)}`;
  const headPath = join(gitDir, 'HEAD');
  const commonDir = commonGitDir(gitDir);
  const refPath = headRefPath(gitDir, commonDir);
  const packedRefsPath = join(commonDir, 'packed-refs');
  return [
    safeMtimeMs(join(gitDir, 'index')),
    safeMtimeMs(headPath),
    refPath ? safeMtimeMs(refPath) : 0,
    safeMtimeMs(packedRefsPath),
    workingTreeMtimeToken(workspacePath),
  ].join(':');
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
  const cacheKey = resolve(workspacePath);
  const token = reviewMtimeToken(cacheKey);
  const cached = liveReviewChangeCache.get(cacheKey);
  if (cached?.token === token) {
    return cached.changeSet;
  }

  const [nameStatusRaw, numStatRaw, untrackedRaw] = await Promise.all([
    execFileAsync('git', ['-C', workspacePath, 'diff', '--name-status', '--relative', '-M', 'HEAD'], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }).then((result) => result.stdout).catch(() => ''),
    execFileAsync('git', ['-C', workspacePath, 'diff', '--numstat', '--relative', '-M', 'HEAD'], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }).then((result) => result.stdout).catch(() => ''),
    execFileAsync('git', ['-C', workspacePath, 'ls-files', '--others', '--exclude-standard'], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }).then((result) => result.stdout).catch(() => ''),
  ]);

  const changedFiles = parseChangedFiles(nameStatusRaw, numStatRaw, untrackedRaw);
  const additions = changedFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = changedFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  const changeSet = {
    repoPath,
    workspacePath,
    sessionKey,
    changedFiles,
    additions,
    deletions,
    files: changedFiles.length,
  };
  liveReviewChangeCache.set(cacheKey, { token, changeSet });
  return changeSet;
}
