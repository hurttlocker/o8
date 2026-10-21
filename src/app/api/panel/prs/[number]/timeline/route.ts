export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { DEFAULT_GITHUB_REPO, resolveRepoSlug } from '@/lib/github-broker';
import { fetchPullRequestTimelinePage } from '@/lib/github-broker/pull-request-timeline';

export async function GET(request: Request, { params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  const search = new URL(request.url).searchParams;
  const page = Number(search.get('page') ?? 1);
  if (!/^\d+$/.test(number) || !Number.isSafeInteger(Number(number)) || Number(number) < 1 || !Number.isSafeInteger(page) || page < 1) {
    return NextResponse.json({ error: 'Choose a valid pull request and activity page.' }, { status: 400 });
  }
  try {
    const repo = await resolveRepoSlug(search.get('repo'), DEFAULT_GITHUB_REPO);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return NextResponse.json({ error: 'Choose a connected repository.' }, { status: 400 });
    return NextResponse.json(await fetchPullRequestTimelinePage(repo, Number(number), page, request.signal));
  } catch {
    return NextResponse.json({ error: 'Activity could not be loaded. Check your GitHub connection in Settings, then retry.' }, { status: 502 });
  }
}
