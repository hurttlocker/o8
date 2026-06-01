export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { performance } from 'node:perf_hooks';
import { fetchGitHubCommits, resolveRepoSlug, DEFAULT_GITHUB_REPO } from '@/lib/github-broker';
import { getCached, setCached } from '@/lib/github/cache';
import { getRecentWorkspaceCommits, resolveWorkspaceRoot } from '@/lib/panel/git-commits';

function parseLimit(value: string | null, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, max));
}

export async function GET(req: NextRequest) {
  const startedAt = performance.now();
  const workspace = req.nextUrl.searchParams.get('workspace');
  if (workspace) {
    const limit = parseLimit(req.nextUrl.searchParams.get('limit'), 20, 50);
    try {
      const commits = getRecentWorkspaceCommits(workspace, limit);
      return NextResponse.json({
        commits,
        workspace: resolveWorkspaceRoot(workspace),
      }, { headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
    } catch (error) {
      return NextResponse.json({
        commits: [],
        workspace: resolveWorkspaceRoot(workspace),
        error: error instanceof Error ? error.message : 'Failed to fetch local commits',
      }, { status: 500, headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
    }
  }

  const repo = await resolveRepoSlug(req.nextUrl.searchParams.get('repo'), DEFAULT_GITHUB_REPO);
  const limit = parseLimit(req.nextUrl.searchParams.get('limit'), 15, 30);

  if (!repo) {
    return NextResponse.json({ commits: [], repo: '', error: 'Invalid repo format' }, { status: 400, headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
  }

  const cacheKey = `commits:${repo}:${limit}`;
  const cached = getCached<unknown[]>(cacheKey);
  if (cached) {
    return NextResponse.json({ commits: cached, repo }, { headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
  }

  try {
    const commits = await fetchGitHubCommits(repo, limit);
    setCached(cacheKey, commits);
    return NextResponse.json({ commits, repo }, { headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
  } catch (error) {
    return NextResponse.json({ commits: [], repo, error: error instanceof Error ? error.message : 'Failed to fetch commits' }, { headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
  }
}
