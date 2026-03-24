export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_GITHUB_REPO, fetchGitHubIssueDetail, resolveRepoSlug } from '@/lib/github-broker';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
  const { number: num } = await params;
  const { searchParams } = new URL(request.url);
  const repo = await resolveRepoSlug(searchParams.get('repo'), DEFAULT_GITHUB_REPO);
  const issueNumber = parseInt(num, 10);

  if (!Number.isFinite(issueNumber) || issueNumber < 1) {
    return NextResponse.json({ error: 'Invalid issue number' }, { status: 400 });
  }

  if (!repo) {
    return NextResponse.json({ error: 'repo is required' }, { status: 400 });
  }

  try {
    const issue = await fetchGitHubIssueDetail(repo, issueNumber);
    return NextResponse.json({ issue, repo });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Issue not found', repo },
      { status: 404 },
    );
  }
}
