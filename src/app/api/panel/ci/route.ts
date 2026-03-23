import { execSync } from 'child_process';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { ghExec, detectRepo } from '@/lib/github';
import { getCached, setCached, SLOW_TTL_MS } from '@/lib/github/cache';

const DEFAULT_REPO = process.env.GITHUB_REPO || '';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repo = searchParams.get('repo') || DEFAULT_REPO;

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
    const runsJson = execSync(
      `gh run list --repo ${repo} --limit 15 --json databaseId,displayTitle,event,headBranch,status,conclusion,createdAt,updatedAt,workflowName,url`,
      { encoding: 'utf-8', timeout: 15000 },
    );

    const runs = JSON.parse(runsJson);
    setCached(cacheKey, runs);
    return NextResponse.json({ runs, repo });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, runs: [], repo }, { status: 200 });
  }
}
