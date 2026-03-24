import { NextRequest, NextResponse } from 'next/server';
import { fetchGitHubCommits, resolveRepoSlug, DEFAULT_GITHUB_REPO } from '@/lib/github-broker';
import { getCached, setCached } from '@/lib/github/cache';

export async function GET(req: NextRequest) {
  const repo = await resolveRepoSlug(req.nextUrl.searchParams.get('repo'), DEFAULT_GITHUB_REPO);
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') ?? '15', 10), 30);

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
