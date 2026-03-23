export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listRepos } from '@/lib/repos/registry';
import { getCached, setCached } from '@/lib/github/cache';
import { getGitHubToken } from '@/lib/github';

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

  return DEFAULT_REPO;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repo = await resolveRepoSlug(searchParams.get('repo'));

  if (!repo) {
    return NextResponse.json({ error: 'Invalid repo format', issues: [] }, { status: 400 });
  }

  // Check cache first
  const cacheKey = `issues:${repo}`;
  const cached = getCached<unknown[]>(cacheKey);
  if (cached) {
    return NextResponse.json({ issues: cached, repo });
  }

  try {
    const token = getGitHubToken();
    const env = token ? { ...process.env, GH_TOKEN: token } : undefined;
    const { stdout } = await execFileAsync('gh', [
      'issue', 'list',
      '--repo', repo,
      '--state', 'open',
      '--limit', '15',
      '--json', 'number,title,labels,state,author,assignees,comments,body,createdAt',
    ], { timeout: 15_000, env });

    const issues = (JSON.parse(stdout || '[]') as Array<{
      number?: number;
      title?: string;
      labels?: Array<{ name: string; color: string }>;
      state?: string;
      author?: { login?: string | null } | null;
      assignees?: Array<{ login?: string | null }>;
      comments?: number | unknown[];
      body?: string;
      createdAt?: string;
    }>).map((issue) => ({
      number: issue.number ?? 0,
      title: issue.title ?? '',
      labels: (issue.labels ?? []).map((label) => ({
        name: label.name,
        color: label.color,
      })),
      state: issue.state ?? 'OPEN',
      author: issue.author?.login ? { login: issue.author.login } : null,
      assignees: (issue.assignees ?? [])
        .map((assignee) => assignee.login ? { login: assignee.login } : null)
        .filter(Boolean),
      comments: Array.isArray(issue.comments) ? issue.comments.length : (issue.comments ?? 0),
      body: issue.body ?? '',
      createdAt: issue.createdAt ?? '',
    }));
    setCached(cacheKey, issues);
    return NextResponse.json({ issues, repo });
  } catch {
    return NextResponse.json({ issues: [], repo });
  }
}
