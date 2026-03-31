import { NextResponse } from 'next/server';
import {
  DEFAULT_GITHUB_REPO,
  commentOnGitHubPullRequest,
  mergeGitHubPullRequest,
  resolveRepoSlug,
  reviewGitHubPullRequest,
} from '@/lib/github-broker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as {
    repo?: string | null;
    number?: number | string | null;
    action?: string | null;
    comment?: string | null;
  } | null;

  const prNumber = typeof body?.number === 'number'
    ? body.number
    : typeof body?.number === 'string'
      ? parseInt(body.number, 10)
      : Number.NaN;
  const action = body?.action?.trim() ?? '';
  const comment = body?.comment?.trim() ?? '';
  const repo = await resolveRepoSlug(body?.repo ?? null, DEFAULT_GITHUB_REPO);

  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: 'Invalid repo format' }, { status: 400 });
  }

  if (!Number.isFinite(prNumber) || prNumber < 1) {
    return NextResponse.json({ error: 'Valid pull request number required' }, { status: 400 });
  }

  if (!action) {
    return NextResponse.json({ error: 'Action is required' }, { status: 400 });
  }

  try {
    if (action === 'approve') {
      await reviewGitHubPullRequest(repo, prNumber, { event: 'APPROVE', body: comment || undefined });
      return NextResponse.json({ ok: true, success: true, action: 'approved' });
    }

    if (action === 'request_changes') {
      if (!comment) {
        return NextResponse.json({ error: 'Comment required for request_changes' }, { status: 400 });
      }
      await reviewGitHubPullRequest(repo, prNumber, { event: 'REQUEST_CHANGES', body: comment });
      return NextResponse.json({ ok: true, success: true, action: 'changes_requested' });
    }

    if (action === 'comment') {
      if (!comment) {
        return NextResponse.json({ error: 'Comment text required' }, { status: 400 });
      }
      await commentOnGitHubPullRequest(repo, prNumber, comment);
      return NextResponse.json({ ok: true, success: true, action: 'commented' });
    }

    if (action === 'merge') {
      await mergeGitHubPullRequest(repo, prNumber, { deleteBranch: true });
      return NextResponse.json({ ok: true, success: true, action: 'merged' });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : `${action} failed`;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
