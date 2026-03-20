export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { listRepos } from '@/lib/repos/registry';

const DEFAULT_REPO = process.env.GITHUB_REPO || 'hurttlocker/cortex-ide';

function normalizeRepoSlug(remoteUrl: string | null | undefined) {
  if (!remoteUrl) return null;
  const normalized = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

async function resolveCandidateRepos(preferredRepo: string) {
  const registered = await listRepos().catch(() => []);
  const candidateRepos = new Set<string>([preferredRepo, DEFAULT_REPO]);
  for (const entry of registered) {
    const slug = normalizeRepoSlug(entry.remoteUrl);
    if (slug) candidateRepos.add(slug);
  }
  return Array.from(candidateRepos).filter((repo) => /^[\w.-]+\/[\w.-]+$/.test(repo));
}

function isMissingPrError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Could not resolve to a PullRequest')
    || message.includes('no pull requests found')
    || message.includes('pull request not found');
}

function loadPrDetail(prNum: number, repo: string) {
  const prJson = execSync(
    `gh pr view ${prNum} --repo ${repo} --json number,title,body,state,author,headRefName,baseRefName,additions,deletions,changedFiles,createdAt,mergedAt,closedAt,mergedBy,labels,reviews,comments,statusCheckRollup,files,url`,
    { encoding: 'utf-8', timeout: 15000 },
  );
  return JSON.parse(prJson);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ number: string }> },
) {
  const { number } = await params;
  const prNum = parseInt(number, 10);
  const { searchParams } = new URL(request.url);
  const repo = searchParams.get('repo') || DEFAULT_REPO;

  if (isNaN(prNum) || prNum < 1) {
    return NextResponse.json({ error: 'Invalid PR number' }, { status: 400 });
  }

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: 'Invalid repo format' }, { status: 400 });
  }

  try {
    const candidateRepos = await resolveCandidateRepos(repo);
    let resolvedRepo = repo;
    let pr: Record<string, unknown> | null = null;
    let lastError: unknown = null;

    for (const candidateRepo of candidateRepos) {
      try {
        pr = loadPrDetail(prNum, candidateRepo);
        resolvedRepo = candidateRepo;
        break;
      } catch (error) {
        lastError = error;
        if (!isMissingPrError(error)) {
          throw error;
        }
      }
    }

    if (!pr) {
      const message = lastError instanceof Error ? lastError.message : `PR #${prNum} not found`;
      return NextResponse.json({ error: message }, { status: 404 });
    }

    let reviewComments: unknown[] = [];
    try {
      const commentsJson = execSync(
        `gh api repos/${resolvedRepo}/pulls/${prNum}/comments --jq '[.[] | {id: .id, body: .body, user: .user.login, path: .path, line: .line, created_at: .created_at}]'`,
        { encoding: 'utf-8', timeout: 10000 },
      );
      reviewComments = JSON.parse(commentsJson);
    } catch { /* no review comments */ }

    let issueComments: unknown[] = [];
    try {
      const icJson = execSync(
        `gh api repos/${resolvedRepo}/issues/${prNum}/comments --jq '[.[] | {id: .id, body: .body, user: .user.login, created_at: .created_at}]'`,
        { encoding: 'utf-8', timeout: 10000 },
      );
      issueComments = JSON.parse(icJson);
    } catch { /* no issue comments */ }

    let diffStat = '';
    try {
      diffStat = execSync(
        `gh pr diff ${prNum} --repo ${resolvedRepo} --stat`,
        { encoding: 'utf-8', timeout: 10000, maxBuffer: 512 * 1024 },
      ).trim();
    } catch { /* no diff stat */ }

    return NextResponse.json({
      pr: {
        ...pr,
        resolvedRepo,
        reviewComments,
        issueComments,
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

  const repo = body.repo || DEFAULT_REPO;
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
