import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ReviewChangedFile,
  ReviewIssueSummary,
  ReviewPullRequestSummary,
  ReviewWorktreeSummary,
  WorkflowReviewSnapshot,
} from '@/lib/fleet/types';

const execFileAsync = promisify(execFile);
const REVIEW_REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || '/Users/marquisehurtt/clawd/repos/cortex-ide';
const REVIEW_REPO_SLUG = process.env.CORTEX_IDE_REVIEW_REPO || 'hurttlocker/cortex-ide';
const FALLBACK_ACTIVE_ISSUE_NUMBER = Number.parseInt(process.env.CORTEX_IDE_ACTIVE_REVIEW_ISSUE || '18', 10);
const REVIEW_NOISE_PATHS = new Set(['next-env.d.ts']);

function shortenPath(path: string) {
  return path.replace('/Users/marquisehurtt/', '~/');
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

export async function getWorkspaceReviewSnapshot(): Promise<WorkflowReviewSnapshot> {
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

  const changedFiles = parseChangedFiles(nameStatusRaw, numStatRaw, untrackedRaw);
  const diffStat = diffStatRaw || (changedFiles.length ? 'Working tree changed, but git diff --stat returned no visible summary.' : 'Working tree clean.');
  const recentCommits = recentCommitsRaw ? recentCommitsRaw.split('\n').filter(Boolean) : [];
  const worktrees = parseWorktrees(worktreesRaw);

  const branchPullRequests = parseJson<ReviewPullRequestSummary[]>(branchPrsRaw, []);
  const fallbackPullRequests = parseJson<ReviewPullRequestSummary[]>(fallbackPrsRaw, []);

  const pullRequests = (branchPullRequests.length ? branchPullRequests : fallbackPullRequests).map((pullRequest) => ({
    ...pullRequest,
    reviewDecision: normalizeReviewDecision(pullRequest.reviewDecision),
    linkedIssueNumbers: parseLinkedIssueNumbers(pullRequest.body),
  }));

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
    dirty: changedFiles.length > 0,
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
