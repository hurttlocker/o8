export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

const DEFAULT_REPO = process.env.GITHUB_REPO || 'hurttlocker/cortex-ide';

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
    const prJson = execSync(
      `gh pr view ${prNum} --repo ${repo} --json number,title,body,state,author,headRefName,baseRefName,additions,deletions,changedFiles,createdAt,mergedAt,closedAt,mergedBy,labels,reviews,comments,statusCheckRollup,files,url`,
      { encoding: 'utf-8', timeout: 15000 },
    );

    const pr = JSON.parse(prJson);

    let reviewComments: unknown[] = [];
    try {
      const commentsJson = execSync(
        `gh api repos/${repo}/pulls/${prNum}/comments --jq '[.[] | {id: .id, body: .body, user: .user.login, path: .path, line: .line, created_at: .created_at}]'`,
        { encoding: 'utf-8', timeout: 10000 },
      );
      reviewComments = JSON.parse(commentsJson);
    } catch { /* no review comments */ }

    let issueComments: unknown[] = [];
    try {
      const icJson = execSync(
        `gh api repos/${repo}/issues/${prNum}/comments --jq '[.[] | {id: .id, body: .body, user: .user.login, created_at: .created_at}]'`,
        { encoding: 'utf-8', timeout: 10000 },
      );
      issueComments = JSON.parse(icJson);
    } catch { /* no issue comments */ }

    let diffStat = '';
    try {
      diffStat = execSync(
        `gh pr diff ${prNum} --repo ${repo} --stat`,
        { encoding: 'utf-8', timeout: 10000, maxBuffer: 512 * 1024 },
      ).trim();
    } catch { /* no diff stat */ }

    return NextResponse.json({
      pr: {
        ...pr,
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
