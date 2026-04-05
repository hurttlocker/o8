export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { fetchGitHubCommits, resolveRepoSlug, DEFAULT_GITHUB_REPO } from '@/lib/github-broker';
import { getCached, setCached } from '@/lib/github/cache';
import { getRecentWorkspaceCommits, resolveWorkspaceRoot } from '@/lib/panel/git-commits';

function parseLimit(value: string | null, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, max));
}

export async function GET(req: NextRequest) {
  const workspace = req.nextUrl.searchParams.get('workspace');
  if (workspace) {
    const limit = parseLimit(req.nextUrl.searchParams.get('limit'), 20, 50);
    try {
      const commits = getRecentWorkspaceCommits(workspace, limit);
      return NextResponse.json({
        commits,
        workspace: resolveWorkspaceRoot(workspace),
      });
    } catch (error) {
      return NextResponse.json({
        commits: [],
        workspace: resolveWorkspaceRoot(workspace),
        error: error instanceof Error ? error.message : 'Failed to fetch local commits',
      }, { status: 500 });
    }
  }

  const repo = await resolveRepoSlug(req.nextUrl.searchParams.get('repo'), DEFAULT_GITHUB_REPO);
  const limit = parseLimit(req.nextUrl.searchParams.get('limit'), 15, 30);

  if (!repo) {
    return NextResponse.json({ commits: [], repo: '', error: 'Invalid repo format' }, { status: 400 });
  }

  const cacheKey = `commits:${repo}:${limit}`;
  const cached = getCached<unknown[]>(cacheKey);
  if (cached) {
    return NextResponse.json({ commits: cached, repo });
  }

  try {
    const commits = await fetchGitHubCommits(repo, limit);
    setCached(cacheKey, commits);
    return NextResponse.json({ commits, repo });
  } catch (error) {
    return NextResponse.json({ commits: [], repo, error: error instanceof Error ? error.message : 'Failed to fetch commits' });
  }
}
