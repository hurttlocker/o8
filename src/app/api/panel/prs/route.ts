export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureGitHubPullRequests, normalizeRepoSlug, resolveRepoSlug } from '@/lib/github-broker';

const DEFAULT_REPO = process.env.CORTEX_IDE_REVIEW_REPO || '';
const execFileAsync = promisify(execFile);

async function transientRepoSlug(repoPath: string | null): Promise<string | null> {
  if (!repoPath?.trim()) return null;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'config', '--get', 'remote.origin.url'],
      { encoding: 'utf-8', windowsHide: true, timeout: 2_500, maxBuffer: 128 * 1024 },
    );
    return normalizeRepoSlug(stdout.trim());
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get('repoPath');
  const repo = repoPath
    ? await transientRepoSlug(repoPath)
    : await resolveRepoSlug(searchParams.get('repo'), '') || DEFAULT_REPO;

  if (!repo) {
    return NextResponse.json({ prs: [], repo: null, unavailable: true });
  }

  const result = await ensureGitHubPullRequests(repo);
  return NextResponse.json({
    prs: result.prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.author,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      state: pr.state,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      statusCheckRollup: pr.statusCheckRollup,
      reviewDecision: pr.reviewDecision,
      url: pr.url,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
    })),
    repo,
    error: result.error,
    stale: result.stale,
  });
}
