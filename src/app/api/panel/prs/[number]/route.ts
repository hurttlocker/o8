export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  DEFAULT_GITHUB_REPO,
  closeGitHubPullRequest,
  commentOnGitHubPullRequest,
  fetchGitHubPullRequestComments,
  fetchGitHubPullRequestDetail,
  mergeGitHubPullRequest,
  reviewGitHubPullRequest,
  resolveRepoSlug,
} from '@/lib/github-broker';
import { listRepos } from '@/lib/repos/registry';
import { getRepoReadiness } from '@/lib/repos/readiness';
import { deriveWorkflowStage } from '@/lib/workflows/status';

function normalizeRepoSlug(remoteUrl: string | null | undefined) {
  if (!remoteUrl) return null;
  const normalized = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

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
    const localRepo = (await listRepos().catch(() => []))
      .find((entry) => normalizeRepoSlug(entry.remoteUrl) === repo) ?? null;
    const readiness = localRepo ? await getRepoReadiness(localRepo).catch(() => null) : null;
    const failedChecks = (pr.statusCheckRollup ?? []).filter((check) => check.conclusion && check.conclusion.toLowerCase() !== 'success').length;
    const pendingChecks = (pr.statusCheckRollup ?? []).filter((check) => !check.conclusion || check.status?.toLowerCase() !== 'completed').length;
    const requestedChanges = (commentsData.reviews ?? []).filter((review) => review.state?.toLowerCase() === 'changes_requested').length;
    const workflowStage = deriveWorkflowStage({
      prState: pr.state,
      failedChecks,
      pendingChecks,
      requestedChanges,
      readinessState: readiness?.state ?? null,
    });

    const diffStat = pr.files
      .map((file) => `${file.path} | +${file.additions} -${file.deletions}`)
      .join('\n');

    return NextResponse.json({
      pr: {
        ...pr,
        resolvedRepo: repo,
        readiness,
        workflowStage,
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

  const repo = await resolveRepoSlug(body.repo ?? null, DEFAULT_GITHUB_REPO);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: 'Invalid repo format' }, { status: 400 });
  }

  const { action, comment } = body;

  try {
    if (action === 'approve') {
      await reviewGitHubPullRequest(repo, prNum, { event: 'APPROVE', body: comment });
      return NextResponse.json({ ok: true, action: 'approved' });
    }

    if (action === 'request-changes') {
      if (!comment) {
        return NextResponse.json({ error: 'Comment required for requesting changes' }, { status: 400 });
      }
      await reviewGitHubPullRequest(repo, prNum, { event: 'REQUEST_CHANGES', body: comment });
      return NextResponse.json({ ok: true, action: 'changes_requested' });
    }

    if (action === 'comment') {
      if (!comment) {
        return NextResponse.json({ error: 'Comment body required' }, { status: 400 });
      }
      await commentOnGitHubPullRequest(repo, prNum, comment);
      return NextResponse.json({ ok: true, action: 'commented' });
    }

    if (action === 'merge') {
      await mergeGitHubPullRequest(repo, prNum, { deleteBranch: true });
      return NextResponse.json({ ok: true, action: 'merged' });
    }

    if (action === 'close') {
      await closeGitHubPullRequest(repo, prNum);
      return NextResponse.json({ ok: true, action: 'closed' });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
