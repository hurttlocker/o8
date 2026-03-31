import { NextResponse } from 'next/server';
import {
  DEFAULT_GITHUB_REPO,
  fetchGitHubPullRequestReviewThreads,
  resolveRepoSlug,
} from '@/lib/github-broker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  try {
    const threads = await fetchGitHubPullRequestReviewThreads(repo, prNumber);
    return NextResponse.json({ ok: true, repo, number: prNumber, threads });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch review threads';
    return NextResponse.json({ error: message, repo, number: prNumber, threads: [] }, { status: 500 });
  }
}
