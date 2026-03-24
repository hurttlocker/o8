export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import {
  DEFAULT_GITHUB_REPO,
  fetchGitHubPullRequestComments,
  fetchGitHubPullRequestDetail,
  resolveRepoSlug,
} from '@/lib/github-broker';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ number: string }> },
) {
  const { number } = await params;
  const prNum = parseInt(number, 10);
  const { searchParams } = new URL(request.url);
  const repo = await resolveRepoSlug(searchParams.get('repo'), DEFAULT_GITHUB_REPO);

  if (isNaN(prNum) || prNum < 1) {
    return NextResponse.json({ error: 'Invalid PR number' }, { status: 400 });
  }

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: 'Invalid repo format' }, { status: 400 });
  }

  try {
    const [pr, commentsData] = await Promise.all([
      fetchGitHubPullRequestDetail(repo, prNum),
      fetchGitHubPullRequestComments(repo, prNum),
    ]);

    const diffStat = pr.files
      .map((file) => `${file.path} | +${file.additions} -${file.deletions}`)
      .join('\n');

    return NextResponse.json({
      pr: {
        ...pr,
        resolvedRepo: repo,
        reviewComments: commentsData.comments,
        issueComments: commentsData.issueComments,
        diffStat,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ number: string }> },
) {
  const { number } = await params;
  const prNum = parseInt(number, 10);

  if (isNaN(prNum) || prNum < 1) {
    return NextResponse.json({ error: 'Invalid PR number' }, { status: 400 });
  }

  let body: { action: string; repo?: string; comment?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const repo = body.repo || DEFAULT_GITHUB_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: 'Invalid repo format' }, { status: 400 });
  }

  const { action, comment } = body;

  try {
    if (action === 'approve') {
      const cmd = comment
        ? `gh pr review ${prNum} --repo ${repo} --approve --body ${JSON.stringify(comment)}`
        : `gh pr review ${prNum} --repo ${repo} --approve`;
      execSync(cmd, { encoding: 'utf-8', timeout: 15000 });
      return NextResponse.json({ ok: true, action: 'approved' });
    }

    if (action === 'request-changes') {
      if (!comment) {
        return NextResponse.json({ error: 'Comment required for requesting changes' }, { status: 400 });
      }
      execSync(
        `gh pr review ${prNum} --repo ${repo} --request-changes --body ${JSON.stringify(comment)}`,
        { encoding: 'utf-8', timeout: 15000 },
      );
      return NextResponse.json({ ok: true, action: 'changes_requested' });
    }

    if (action === 'comment') {
      if (!comment) {
        return NextResponse.json({ error: 'Comment body required' }, { status: 400 });
      }
      execSync(
        `gh pr comment ${prNum} --repo ${repo} --body ${JSON.stringify(comment)}`,
        { encoding: 'utf-8', timeout: 15000 },
      );
      return NextResponse.json({ ok: true, action: 'commented' });
    }

    if (action === 'merge') {
      execSync(
        `gh pr merge ${prNum} --repo ${repo} --squash --delete-branch`,
        { encoding: 'utf-8', timeout: 30000 },
      );
      return NextResponse.json({ ok: true, action: 'merged' });
    }

    if (action === 'close') {
      execSync(
        `gh pr close ${prNum} --repo ${repo}`,
        { encoding: 'utf-8', timeout: 15000 },
      );
      return NextResponse.json({ ok: true, action: 'closed' });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
