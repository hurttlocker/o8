export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { DEFAULT_GITHUB_REPO, fetchGitHubWorkflowRunDetail, resolveRepoSlug } from '@/lib/github-broker';
import { GitHubRequestDeferredError } from '@/lib/github-broker/request-budget';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const repo = await resolveRepoSlug(searchParams.get('repo'), DEFAULT_GITHUB_REPO);
  const runId = parseInt(id, 10);

  if (isNaN(runId) || !repo) {
    return NextResponse.json({ error: 'Invalid run ID' }, { status: 400 });
  }

  try {
    const detail = await fetchGitHubWorkflowRunDetail(repo, runId);
    return NextResponse.json({ ...detail, repo });
  } catch (err) {
    if (err instanceof GitHubRequestDeferredError) {
      return NextResponse.json({ error: err.message }, {
        status: 429,
        headers: { 'Retry-After': String(Math.max(1, Math.ceil((err.retryAt - Date.now()) / 1000))) },
      });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
