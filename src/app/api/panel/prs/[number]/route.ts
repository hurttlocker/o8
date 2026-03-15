export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

const REPO = process.env.GITHUB_REPO || 'hurttlocker/cortex-ide';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ number: string }> },
) {
  const { number } = await params;
  const prNum = parseInt(number, 10);

  if (isNaN(prNum) || prNum < 1) {
    return NextResponse.json({ error: 'Invalid PR number' }, { status: 400 });
  }

  try {
    // Get PR detail
    const prJson = execSync(
      `gh pr view ${prNum} --repo ${REPO} --json number,title,body,state,author,headRefName,baseRefName,additions,deletions,changedFiles,createdAt,mergedAt,closedAt,mergedBy,labels,reviews,comments,statusCheckRollup,files,url`,
      { encoding: 'utf-8', timeout: 15000 },
    );

    const pr = JSON.parse(prJson);

    // Get review comments (if any)
    let reviewComments: unknown[] = [];
    try {
      const commentsJson = execSync(
        `gh api repos/${REPO}/pulls/${prNum}/comments --jq '[.[] | {id: .id, body: .body, user: .user.login, path: .path, line: .line, created_at: .created_at}]'`,
        { encoding: 'utf-8', timeout: 10000 },
      );
      reviewComments = JSON.parse(commentsJson);
    } catch { /* no review comments */ }

    // Get issue comments (conversation)
    let issueComments: unknown[] = [];
    try {
      const icJson = execSync(
        `gh api repos/${REPO}/issues/${prNum}/comments --jq '[.[] | {id: .id, body: .body, user: .user.login, created_at: .created_at}]'`,
        { encoding: 'utf-8', timeout: 10000 },
      );
      issueComments = JSON.parse(icJson);
    } catch { /* no issue comments */ }

    // Get diff stat
    let diffStat = '';
    try {
      diffStat = execSync(
        `gh pr diff ${prNum} --repo ${REPO} --stat`,
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
