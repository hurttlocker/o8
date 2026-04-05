import { NextResponse } from 'next/server';
import {
  DEFAULT_GITHUB_REPO,
  fetchGitHubPullRequestReviewThreads,
  resolveRepoSlug,
} from '@/lib/github-broker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── In-memory cache for GraphQL review threads (conserve rate limit) ──
const THREADS_CACHE_TTL_MS = 120_000; // 2 min — GraphQL budget is precious
const threadsCache = new Map<string, { data: unknown; ts: number }>();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repo = await resolveRepoSlug(searchParams.get('repo'), DEFAULT_GITHUB_REPO);
  const prNumber = parseInt(searchParams.get('number') ?? '', 10);

  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: 'Invalid repo format' }, { status: 400 });
  }

  if (!Number.isFinite(prNumber) || prNumber < 1) {
    return NextResponse.json({ error: 'Valid pull request number required' }, { status: 400 });
  }

  const cacheKey = `${repo}#${prNumber}`;
  const cached = threadsCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < THREADS_CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  try {
    const threads = await fetchGitHubPullRequestReviewThreads(repo, prNumber);
    const payload = { ok: true, repo, number: prNumber, threads };
    threadsCache.set(cacheKey, { data: payload, ts: Date.now() });
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch review threads';
    return NextResponse.json({ error: message, repo, number: prNumber, threads: [] }, { status: 500 });
  }
}
