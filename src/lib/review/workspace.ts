import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ReviewChangedFile,
  ReviewIssueSummary,
  ReviewPullRequestSummary,
  ReviewWorktreeSummary,
  WorkflowReviewSnapshot,
} from '@/lib/fleet/types';
import type { MobileReviewFileDetail } from '@/lib/mobile/types';

const execFileAsync = promisify(execFile);
const REVIEW_REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || '/Users/marquisehurtt/clawd/repos/cortex-ide';
const REVIEW_REPO_SLUG = process.env.CORTEX_IDE_REVIEW_REPO || 'hurttlocker/cortex-ide';
const FALLBACK_ACTIVE_ISSUE_NUMBER = Number.parseInt(process.env.CORTEX_IDE_ACTIVE_REVIEW_ISSUE || '18', 10);
const REVIEW_NOISE_PATHS = new Set(['next-env.d.ts']);

function shortenPath(path: string) {
  return path.replace('/Users/marquisehurtt/', '~/');
}

// Cache changed files list for 30 seconds to avoid re-running git commands per file click
let _cachedChangedFiles: ReviewChangedFile[] | null = null;
let _cachedChangedFilesAt = 0;
const CHANGED_FILES_CACHE_TTL_MS = 30_000;

// Full snapshot cache — prevents repeated git/gh spawns from mobile inbox and API routes
const REVIEW_SNAPSHOT_TTL_MS = 20_000;
let _reviewSnapshotCache: { snapshot: WorkflowReviewSnapshot; cachedAt: number } | null = null;
let _reviewSnapshotInflight: Promise<WorkflowReviewSnapshot> | null = null;

export function invalidateReviewSnapshotCache() {
  _reviewSnapshotCache = null;
  _reviewSnapshotInflight = null;
}

async function getCachedChangedFiles(): Promise<ReviewChangedFile[]> {
  const now = Date.now();
  if (_cachedChangedFiles && now - _cachedChangedFilesAt < CHANGED_FILES_CACHE_TTL_MS) {
    return _cachedChangedFiles;
  }
  const files = await loadReviewChangedFiles();
  const sorted = await sortChangedFilesByTouchedAt(files);
  _cachedChangedFiles = sorted;
  _cachedChangedFilesAt = now;
  return sorted;
}

function parseJson<T>(raw: string, fallback: T) {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeReviewDecision(value?: string | null) {
  if (!value) return null;
  return value.toLowerCase();
}

function parseLinkedIssueNumbers(body?: string) {
  if (!body) return [] as number[];

  const seen = new Set<number>();
  for (const match of body.matchAll(/#(\d+)/g)) {
    const nextNumber = Number.parseInt(match[1] ?? '', 10);
    if (Number.isFinite(nextNumber)) {
      seen.add(nextNumber);
    }
  }

  return Array.from(seen).sort((left, right) => right - left);
}

async function loadIssueSummaries(issueNumbers: number[]) {
  const unique = Array.from(new Set(issueNumbers)).filter((value) => Number.isFinite(value));

  if (!unique.length) {
    return [] as ReviewIssueSummary[];
  }

  const issues = await Promise.all(
    unique.map(async (issueNumber) => {
      const raw = await tryRunFile('gh', [
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        REVIEW_REPO_SLUG,
        '--json',
        'number,title,url,state',
      ]);

      return parseJson<ReviewIssueSummary | undefined>(raw, undefined);
    }),
  );

  return issues
    .filter((issue): issue is ReviewIssueSummary => Boolean(issue))
    .sort((left, right) => {
      if (left.state !== right.state) {
        if (left.state === 'OPEN') return -1;
        if (right.state === 'OPEN') return 1;
      }
      return right.number - left.number;
    });
}

interface PullRequestFileSummary {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previous_filename?: string;
  patch?: string;
}

function normalizePullRequestFileStatus(status?: string): ReviewChangedFile['status'] {
  switch ((status ?? '').toLowerCase()) {
    case 'added':
      return 'added';
    case 'removed':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    case 'copied':
      return 'added';
    case 'modified':
    default:
      return 'modified';
  }
}

function formatPullRequestFilePath(file: PullRequestFileSummary) {
  return file.status === 'renamed' && file.previous_filename
    ? `${file.previous_filename} → ${file.filename}`
    : file.filename;
}

function parsePullRequestChangedFiles(raw: string) {
  const files = parseJson<PullRequestFileSummary[]>(raw, []);

  return files
    .filter((file) => file.filename && !isReviewNoisePath(file.filename) && !isReviewNoisePath(formatPullRequestFilePath(file)))
    .map((file) => ({
      path: formatPullRequestFilePath(file),
      status: normalizePullRequestFileStatus(file.status),
      additions: file.additions,
      deletions: file.deletions,
    } satisfies ReviewChangedFile))
    .sort((a, b) => ((b.additions ?? 0) + (b.deletions ?? 0)) - ((a.additions ?? 0) + (a.deletions ?? 0)));
}

function summarizePullRequestDiff(files: ReviewChangedFile[]) {
  if (!files.length) {
    return 'No PR file summary is visible yet.';
  }

  return files
    .slice(0, 8)
    .map((file) => `${file.path}  +${file.additions ?? 0}  -${file.deletions ?? 0}`)
    .join('\n');
}

async function loadPullRequestFiles(pullRequestNumber: number) {
  const raw = await tryRunFile('gh', [
    'api',
    `repos/${REVIEW_REPO_SLUG}/pulls/${pullRequestNumber}/files?per_page=100`,
  ]);

  return parseJson<PullRequestFileSummary[]>(raw, []);
}

async function runFile(command: string, args: string[]) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: REVIEW_REPO_ROOT,
    maxBuffer: 4 * 1024 * 1024,
  });

  return stdout.trim();
}

async function tryRunFile(command: string, args: string[]) {
  try {
    return await runFile(command, args);
  } catch {
    return '';
  }
}

function parseBranchStatus(raw: string) {
  let branch = 'unknown';
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;

  for (const line of raw.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      branch = line.replace('# branch.head ', '').trim();
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.replace('# branch.upstream ', '').trim();
    }
    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+)\s+\-(\d+)/);
      if (match) {
        ahead = Number.parseInt(match[1] ?? '0', 10);
        behind = Number.parseInt(match[2] ?? '0', 10);
      }
    }
  }

  return { branch, upstream, ahead, behind };
}

function isReviewNoisePath(path: string) {
  return REVIEW_NOISE_PATHS.has(path.trim());
}

function parseChangedFiles(nameStatusRaw: string, numStatRaw: string, untrackedRaw: string) {
  const changed = new Map<string, ReviewChangedFile>();

  for (const line of nameStatusRaw.split('\n').filter(Boolean)) {
    const [statusToken, firstPath, secondPath] = line.split('\t');
    if (!statusToken || !firstPath) continue;

    const status = statusToken[0];
    const path = status === 'R' && secondPath ? `${firstPath} → ${secondPath}` : secondPath ?? firstPath;
    if (isReviewNoisePath(firstPath) || (secondPath && isReviewNoisePath(secondPath)) || isReviewNoisePath(path)) {
      continue;
    }

    changed.set(path, {
      path,
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
    const [additionsRaw, deletionsRaw, path] = line.split('\t');
    if (!path || isReviewNoisePath(path)) continue;

    const entry = changed.get(path) ?? {
      path,
      status: 'modified' as const,
      additions: null,
      deletions: null,
    };

    entry.additions = additionsRaw === '-' ? null : Number.parseInt(additionsRaw ?? '0', 10);
    entry.deletions = deletionsRaw === '-' ? null : Number.parseInt(deletionsRaw ?? '0', 10);
    changed.set(path, entry);
  }

  for (const path of untrackedRaw.split('\n').map((value) => value.trim()).filter(Boolean)) {
    if (isReviewNoisePath(path)) continue;

    changed.set(path, {
      path,
      status: 'untracked',
      additions: null,
      deletions: null,
    });
  }

  return Array.from(changed.values());
}

function parseReviewPath(reviewPath: string) {
  const [originalPath, currentPath] = reviewPath.includes(' → ')
    ? reviewPath.split(' → ')
    : [undefined, reviewPath];

  return {
    originalPath,
    currentPath,
  };
}

function resolveRepoFile(relativePath: string) {
  const repoRoot = path.resolve(REVIEW_REPO_ROOT);
  const nextPath = path.resolve(repoRoot, relativePath);

  if (nextPath !== repoRoot && !nextPath.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error('Requested review file path escapes the repo root.');
  }

  return nextPath;
}

async function fileTouchedAt(reviewPath: string) {
  try {
    const { currentPath } = parseReviewPath(reviewPath);
    if (!currentPath) {
      return 0;
    }
    const target = resolveRepoFile(currentPath);
    const details = await stat(target);
    return details.mtimeMs;
  } catch {
    return 0;
  }
}

async function sortChangedFilesByTouchedAt(changedFiles: ReviewChangedFile[]) {
  const withTouchedAt = await Promise.all(
    changedFiles.map(async (file) => ({
      file,
      touchedAt: await fileTouchedAt(file.path),
    })),
  );

  return withTouchedAt
    .sort((left, right) => {
      if (left.touchedAt !== right.touchedAt) {
        return right.touchedAt - left.touchedAt;
      }
      return left.file.path.localeCompare(right.file.path);
    })
    .map((entry) => entry.file);
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

function trimPreview(text: string, maxLines = 600, maxChars = 40000) {
  const lines = text.split('\n').slice(0, maxLines).join('\n').trim();
  if (!lines) return '';
  return lines.length > maxChars ? `${lines.slice(0, maxChars - 1)}…` : lines;
}

function buildReviewFileNote(
  file: ReviewChangedFile,
  originalPath?: string,
  currentPath?: string,
  source: 'local' | 'pull_request' = 'local',
) {
  const previewLabel = source === 'pull_request' ? 'the committed PR patch' : 'the current local diff';

  switch (file.status) {
    case 'added':
      return source === 'pull_request'
        ? 'Added file • preview shows the committed PR patch already attached to this branch.'
        : 'Added file • preview shows the current local patch against HEAD.';
    case 'deleted':
      return source === 'pull_request'
        ? 'Deleted file • preview shows the committed PR removal patch from GitHub.'
        : 'Deleted file • preview shows the removal diff still waiting in the working tree.';
    case 'renamed':
      return originalPath && currentPath
        ? `Renamed ${originalPath} → ${currentPath} • preview keeps the rename visible on phone via ${previewLabel}.`
        : `Renamed file • preview keeps the rename visible on phone via ${previewLabel}.`;
    case 'untracked':
      return 'Untracked file • git has no HEAD baseline yet, so the phone shows the current file contents instead of a patch.';
    case 'modified':
    default:
      return source === 'pull_request'
        ? 'Modified file • preview shows the committed PR patch so you can triage after push without dropping to desktop first.'
        : 'Modified file • preview shows the current local diff so you can triage without dropping to desktop first.';
  }
}

async function loadReviewChangedFiles() {
  const [nameStatusRaw, numStatRaw, untrackedRaw] = await Promise.all([
    tryRunFile('git', ['diff', '--name-status', '--relative', '-M', 'HEAD']),
    tryRunFile('git', ['diff', '--numstat', '--relative', '-M', 'HEAD']),
    tryRunFile('git', ['ls-files', '--others', '--exclude-standard']),
  ]);

  return parseChangedFiles(nameStatusRaw, numStatRaw, untrackedRaw);
}

async function loadFileCommitSummary(filePath: string): Promise<{ commitSummary?: string; commitAuthor?: string; commitAge?: string }> {
  try {
    const raw = await tryRunFile('git', [
      'log', '-1', '--format=%s%n%an%n%ar', '--follow', '--', filePath,
    ]);
    const [subject, author, age] = raw.trim().split('\n');
    if (!subject) return {};
    return {
      commitSummary: subject,
      commitAuthor: author,
      commitAge: age,
    };
  } catch {
    return {};
  }
}

async function loadReviewFilePreview(file: ReviewChangedFile, originalPath?: string, currentPath?: string) {
  if (file.status === 'untracked' && currentPath) {
    const raw = await readFile(resolveRepoFile(currentPath), 'utf8').catch(() => '');
    return trimPreview(raw)
      ? trimPreview(raw)
      : 'No readable file preview is available for this untracked path yet.';
  }

  const diffTargets = [originalPath, currentPath].filter((value): value is string => Boolean(value));
  const diffPreview = trimPreview(
    await tryRunFile('git', ['diff', '--no-ext-diff', '--unified=16', '--relative', '-M', 'HEAD', '--', ...diffTargets]),
  );

  if (diffPreview) {
    return diffPreview;
  }

  if (currentPath && file.status !== 'deleted') {
    const raw = await readFile(resolveRepoFile(currentPath), 'utf8').catch(() => '');
    const filePreview = trimPreview(raw);
    if (filePreview) {
      return filePreview;
    }
  }

  return 'No inline diff preview is available for this file yet.';
}

async function loadPullRequestFileDetail(pullRequestNumber: number, reviewPath: string) {
  const files = await loadPullRequestFiles(pullRequestNumber);
  const matched = files.find((file) => formatPullRequestFilePath(file) === reviewPath);

  if (!matched) {
    return null;
  }

  const file: ReviewChangedFile = {
    path: formatPullRequestFilePath(matched),
    status: normalizePullRequestFileStatus(matched.status),
    additions: matched.additions,
    deletions: matched.deletions,
  };
  const { originalPath, currentPath } = parseReviewPath(file.path);

  // Prefer local git diff (full, un-truncated) over GitHub API patch
  const localDiff = trimPreview(
    await tryRunFile('git', ['diff', '--no-ext-diff', '--unified=4', 'origin/main...HEAD', '--', ...[originalPath, currentPath].filter((v): v is string => Boolean(v))]),
  );
  const preview = localDiff || trimPreview(matched.patch ?? '') || 'GitHub did not return an inline patch for this file.';
  const commitInfo = await loadFileCommitSummary(currentPath ?? originalPath ?? file.path);

  return {
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    originalPath,
    currentPath,
    note: buildReviewFileNote(file, originalPath, currentPath, 'pull_request'),
    preview,
    ...commitInfo,
  } satisfies MobileReviewFileDetail;
}

function parseWorktrees(raw: string) {
  const worktrees: ReviewWorktreeSummary[] = [];
  const records = raw
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);

  for (const record of records) {
    let path = '';
    let branch: string | undefined;
    let head: string | undefined;
    let isBare = false;
    let isDetached = false;
    let lockedReason: string | undefined;
    let prunableReason: string | undefined;

    for (const line of record.split('\n')) {
      if (line.startsWith('worktree ')) path = line.replace('worktree ', '').trim();
      if (line.startsWith('branch ')) branch = line.replace('branch refs/heads/', '').trim();
      if (line.startsWith('HEAD ')) head = line.replace('HEAD ', '').trim().slice(0, 7);
      if (line === 'bare') isBare = true;
      if (line === 'detached') isDetached = true;
      if (line.startsWith('locked')) lockedReason = line.replace(/^locked\s*/, '').trim() || 'locked';
      if (line.startsWith('prunable')) prunableReason = line.replace(/^prunable\s*/, '').trim() || 'prunable';
    }

    if (!path) continue;

    worktrees.push({
      path: shortenPath(path),
      branch,
      head,
      isCurrent: path === REVIEW_REPO_ROOT,
      isBare,
      isDetached,
      lockedReason,
      prunableReason,
    });
  }

  return worktrees;
}

export async function getReviewFileDetail(reviewPath: string): Promise<MobileReviewFileDetail> {
  const changedFiles = await getCachedChangedFiles();
  const file = changedFiles.find((entry) => entry.path === reviewPath);

  if (file) {
    const { originalPath, currentPath } = parseReviewPath(file.path);
    const [preview, commitInfo] = await Promise.all([
      loadReviewFilePreview(file, originalPath, currentPath),
      loadFileCommitSummary(currentPath ?? originalPath ?? file.path),
    ]);

    return {
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      originalPath,
      currentPath,
      note: buildReviewFileNote(file, originalPath, currentPath),
      preview,
      ...commitInfo,
    };
  }

  const snapshot = await getWorkspaceReviewSnapshot();
  const leadPullRequest = snapshot.pullRequests[0];

  if (leadPullRequest) {
    const committedFile = await loadPullRequestFileDetail(leadPullRequest.number, reviewPath);
    if (committedFile) {
      return committedFile;
    }
  }

  throw new Error('Requested file is no longer part of the live review surface.');
}

export async function getWorkspaceReviewSnapshot(options: { fresh?: boolean } = {}): Promise<WorkflowReviewSnapshot> {
  const fresh = options.fresh ?? false;
  const now = Date.now();
  if (!fresh && _reviewSnapshotCache && now - _reviewSnapshotCache.cachedAt < REVIEW_SNAPSHOT_TTL_MS) {
    return _reviewSnapshotCache.snapshot;
  }
  if (!fresh && _reviewSnapshotInflight) return _reviewSnapshotInflight;

  _reviewSnapshotInflight = _fetchWorkspaceReviewSnapshot().then((snapshot) => {
    _reviewSnapshotCache = { snapshot, cachedAt: Date.now() };
    return snapshot;
  }).finally(() => {
    _reviewSnapshotInflight = null;
  });
  return _reviewSnapshotInflight;
}

async function _fetchWorkspaceReviewSnapshot(): Promise<WorkflowReviewSnapshot> {
  const warnings: string[] = [];

  const branchStatusRaw = await tryRunFile('git', ['status', '--branch', '--porcelain=v2']);
  const { branch, upstream, ahead, behind } = parseBranchStatus(branchStatusRaw);

  const [
    nameStatusRaw,
    numStatRaw,
    untrackedRaw,
    diffStatRaw,
    recentCommitsRaw,
    worktreesRaw,
    branchPrsRaw,
    fallbackPrsRaw,
  ] = await Promise.all([
    tryRunFile('git', ['diff', '--name-status', '--relative', '-M', 'HEAD']),
    tryRunFile('git', ['diff', '--numstat', '--relative', '-M', 'HEAD']),
    tryRunFile('git', ['ls-files', '--others', '--exclude-standard']),
    tryRunFile('git', ['diff', '--stat=120', '--relative', 'HEAD']),
    tryRunFile('git', ['log', '--oneline', '-5']),
    tryRunFile('git', ['worktree', 'list', '--porcelain']),
    tryRunFile('gh', [
      'pr',
      'list',
      '--repo',
      REVIEW_REPO_SLUG,
      '--state',
      'open',
      '--head',
      branch,
      '--json',
      'number,title,url,headRefName,baseRefName,isDraft,reviewDecision,state,body',
    ]),
    tryRunFile('gh', [
      'pr',
      'list',
      '--repo',
      REVIEW_REPO_SLUG,
      '--state',
      'open',
      '--limit',
      '3',
      '--json',
      'number,title,url,headRefName,baseRefName,isDraft,reviewDecision,state,body',
    ]),
  ]);

  const parsedFiles = parseChangedFiles(nameStatusRaw, numStatRaw, untrackedRaw);
  const localChangedFiles = await sortChangedFilesByTouchedAt(parsedFiles);
  // Refresh the cache with the latest sorted list
  _cachedChangedFiles = localChangedFiles;
  _cachedChangedFilesAt = Date.now();
  const recentCommits = recentCommitsRaw ? recentCommitsRaw.split('\n').filter(Boolean) : [];
  const worktrees = parseWorktrees(worktreesRaw);

  const branchPullRequests = parseJson<ReviewPullRequestSummary[]>(branchPrsRaw, []);
  const fallbackPullRequests = parseJson<ReviewPullRequestSummary[]>(fallbackPrsRaw, []);

  const pullRequests = (branchPullRequests.length ? branchPullRequests : fallbackPullRequests).map((pullRequest) => ({
    ...pullRequest,
    reviewDecision: normalizeReviewDecision(pullRequest.reviewDecision),
    linkedIssueNumbers: parseLinkedIssueNumbers(pullRequest.body),
  }));

  const pullRequestFiles = pullRequests[0] ? await loadPullRequestFiles(pullRequests[0].number) : [];
  const pullRequestChangedFiles = pullRequestFiles.length
    ? parsePullRequestChangedFiles(JSON.stringify(pullRequestFiles))
    : [];
  const changedFiles = localChangedFiles.length ? localChangedFiles : pullRequestChangedFiles;
  const diffStat = localChangedFiles.length
    ? summarizeLocalDiff(localChangedFiles, diffStatRaw)
    : pullRequestChangedFiles.length
      ? summarizePullRequestDiff(pullRequestChangedFiles)
      : 'Working tree clean.';

  const linkedIssueNumbers = pullRequests.flatMap((pullRequest) => pullRequest.linkedIssueNumbers ?? []);
  const activeIssues = await loadIssueSummaries(
    linkedIssueNumbers.length ? linkedIssueNumbers : [FALLBACK_ACTIVE_ISSUE_NUMBER],
  );
  const activeIssue = activeIssues[0];

  if (!activeIssues.length) {
    warnings.push(
      linkedIssueNumbers.length
        ? 'Unable to load the linked GitHub issues for the current review lane.'
        : `Unable to load fallback GitHub issue #${FALLBACK_ACTIVE_ISSUE_NUMBER}.`,
    );
  }

  if (!pullRequests.length) {
    warnings.push('No open GitHub pull request is attached to the current branch yet.');
  }

  if (!worktrees.length) {
    warnings.push('No git worktree data was found.');
  }

  return {
    generatedAt: new Date().toISOString(),
    repoSlug: REVIEW_REPO_SLUG,
    repoPath: shortenPath(REVIEW_REPO_ROOT),
    branch,
    upstream,
    ahead,
    behind,
    dirty: localChangedFiles.length > 0,
    changedFiles,
    diffStat,
    recentCommits,
    worktrees,
    pullRequests,
    activeIssue,
    activeIssues,
    warnings,
  };
}
