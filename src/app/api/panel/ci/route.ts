export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { fetchGitHubWorkflowRuns, resolveRepoSlug, DEFAULT_GITHUB_REPO } from '@/lib/github-broker';
import { getCached, setCached, SLOW_TTL_MS } from '@/lib/github/cache';
import { GitHubRequestDeferredError } from '@/lib/github-broker/request-budget';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repo = await resolveRepoSlug(searchParams.get('repo'), DEFAULT_GITHUB_REPO);

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: 'Invalid repo format', runs: [] }, { status: 400 });
  }

  // Check cache first (CI runs change slowly — 60s TTL)
  const cacheKey = `ci:${repo}`;
  const cached = getCached<unknown[]>(cacheKey, SLOW_TTL_MS);
  if (cached) {
    return NextResponse.json({ runs: cached, repo });
  }

  try {
    const runs = await fetchGitHubWorkflowRuns(repo, 15);
    setCached(cacheKey, runs);
    return NextResponse.json({ runs, repo });
  } catch (err) {
    if (err instanceof GitHubRequestDeferredError) {
      return NextResponse.json({ error: err.message, runs: [], repo }, {
        status: 429,
        headers: { 'Retry-After': String(Math.max(1, Math.ceil((err.retryAt - Date.now()) / 1000))) },
      });
    }
    console.error('[panel-ci] Read failed:', err);
    const message = 'Unable to read CI runs.';
    return NextResponse.json({ error: message, runs: [], repo }, { status: 200 });
  }
}
