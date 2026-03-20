export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listRepos } from '@/lib/repos/registry';

const execFileAsync = promisify(execFile);
const DEFAULT_REPO = process.env.CORTEX_IDE_REVIEW_REPO || 'hurttlocker/cortex-ide';

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

  return DEFAULT_REPO;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repo = await resolveRepoSlug(searchParams.get('repo'));

  if (!repo) {
    return NextResponse.json({ error: 'Invalid repo format', issues: [] }, { status: 400 });
  }

  try {
    const { stdout } = await execFileAsync('gh', [
      'issue', 'list',
      '--repo', repo,
      '--state', 'open',
      '--limit', '15',
      '--json', 'number,title,labels,state',
    ], { timeout: 15_000 });

    const issues = JSON.parse(stdout || '[]');
    return NextResponse.json({ issues, repo });
  } catch {
    return NextResponse.json({ issues: [], repo });
  }
}
