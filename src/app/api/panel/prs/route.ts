export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listRepos } from '@/lib/repos/registry';
import { getCached, setCached } from '@/lib/github/cache';

const execFileAsync = promisify(execFile);
const DEFAULT_REPO = process.env.CORTEX_IDE_REVIEW_REPO || '';

function normalizeRepoSlug(remoteUrl: string | null | undefined) {
  if (!remoteUrl) return null;
  const normalized = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

async function resolveRepoSlug(repoLike: string | null) {
  if (!repoLike) return DEFAULT_REPO;
  if (/^[\w.-]+\/[\w.-]+$/.test(repoLike)) return repoLike;

  const registered = await listRepos().catch(() => []);
  const normalizedTarget = repoLike.toLowerCase();
  for (const entry of registered) {
    const slug = normalizeRepoSlug(entry.remoteUrl);
    if (!slug) continue;
    if (slug.toLowerCase() === normalizedTarget) return slug;
    if (slug.split('/')[1]?.toLowerCase() === normalizedTarget) return slug;
    if (entry.name.toLowerCase() === normalizedTarget) return slug;
  }

  return null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repo = await resolveRepoSlug(searchParams.get('repo'));

  if (!repo) {
    return NextResponse.json({ error: 'Invalid repo format', prs: [] }, { status: 400 });
  }

  // Check cache first
  const cacheKey = `prs:${repo}`;
  const cached = getCached<unknown[]>(cacheKey);
  if (cached) {
    return NextResponse.json({ prs: cached, repo });
  }

  try {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'list',
      '--repo', repo,
      '--state', 'open',
      '--limit', '10',
      '--json', 'number,title,author,headRefName,baseRefName,state,additions,deletions,changedFiles,statusCheckRollup,reviewDecision,url,createdAt',
    ], { timeout: 15_000, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' } });

    const prs = JSON.parse(stdout || '[]');
    setCached(cacheKey, prs);
    return NextResponse.json({ prs, repo });
  } catch {
    return NextResponse.json({ prs: [], repo });
  }
}
