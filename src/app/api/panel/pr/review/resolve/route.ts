import { NextResponse } from 'next/server';
import {
  DEFAULT_GITHUB_REPO,
  fetchGitHubPullRequestReviewThreads,
  resolveRepoSlug,
  setGitHubPullRequestReviewThreadResolved,
} from '@/lib/github-broker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as {
    repo?: string | null;
    number?: number | string | null;
    threadId?: string | null;
    resolved?: boolean | null;
  } | null;

  const repo = await resolveRepoSlug(body?.repo ?? null, DEFAULT_GITHUB_REPO);
  const prNumber = typeof body?.number === 'number'
    ? body.number
    : typeof body?.number === 'string'
      ? parseInt(body.number, 10)
      : Number.NaN;
  const threadId = body?.threadId?.trim() ?? '';
  const resolved = typeof body?.resolved === 'boolean' ? body.resolved : null;
  if (resolved === null) {
    return NextResponse.json({ error: 'resolved (boolean) is required' }, { status: 400 });
  }

  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: 'Invalid repo format' }, { status: 400 });
  }

  if (!Number.isFinite(prNumber) || prNumber < 1) {
    return NextResponse.json({ error: 'Valid pull request number required' }, { status: 400 });
  }

  if (!threadId) {
    return NextResponse.json({ error: 'Thread id is required' }, { status: 400 });
  }

  try {
    await setGitHubPullRequestReviewThreadResolved(repo, threadId, resolved);
    const threads = await fetchGitHubPullRequestReviewThreads(repo, prNumber);
    const updatedThread = threads.find((thread) => thread.id === threadId) ?? null;
    return NextResponse.json({ ok: true, repo, number: prNumber, threadId, resolved, thread: updatedThread, threads });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update review thread resolution';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
