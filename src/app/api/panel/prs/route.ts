export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

const REPO = process.env.GITHUB_REPO || 'hurttlocker/cortex-ide';

export async function GET() {
  try {
    // Get recent PRs (open + recently closed/merged, limit 20)
    const openJson = execSync(
      `gh pr list --repo ${REPO} --state open --limit 10 --json number,title,state,author,headRefName,additions,deletions,changedFiles,createdAt,labels`,
      { encoding: 'utf-8', timeout: 15000 },
    );

    const closedJson = execSync(
      `gh pr list --repo ${REPO} --state closed --limit 10 --json number,title,state,author,headRefName,additions,deletions,changedFiles,createdAt,labels`,
      { encoding: 'utf-8', timeout: 15000 },
    );

    const open = JSON.parse(openJson);
    const closed = JSON.parse(closedJson);

    // Combine and sort: open first, then closed by recency
    const all = [...open, ...closed];

    return NextResponse.json({ prs: all });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, prs: [] }, { status: 200 });
  }
}
