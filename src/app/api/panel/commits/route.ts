import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { getCached, setCached } from '@/lib/github/cache';

export async function GET(req: NextRequest) {
  const repo = req.nextUrl.searchParams.get('repo') ?? 'hurttlocker/cortex-ide';
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') ?? '15', 10), 30);

  const cacheKey = `commits:${repo}:${limit}`;
  const cached = getCached<unknown[]>(cacheKey);
  if (cached) {
    return NextResponse.json({ commits: cached, repo });
  }

  try {
    const raw = execSync(
      `gh api "repos/${repo}/commits?per_page=${limit}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();

    const ghCommits = JSON.parse(raw || '[]');
    const commits = ghCommits.map((c: { sha?: string; commit?: { message?: string; committer?: { date?: string } } }) => ({
      hash: (c.sha ?? '').slice(0, 7),
      message: (c.commit?.message ?? '').split('\n')[0],
      date: c.commit?.committer?.date ?? '',
    }));

    setCached(cacheKey, commits);
    return NextResponse.json({ commits, repo });
  } catch {
    return NextResponse.json({ commits: [], repo, error: 'Failed to fetch commits' });
  }
}
