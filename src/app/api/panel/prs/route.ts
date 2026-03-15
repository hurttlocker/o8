export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

const DEFAULT_REPO = process.env.GITHUB_REPO || 'hurttlocker/cortex-ide';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repo = searchParams.get('repo') || DEFAULT_REPO;

  // Validate repo format
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: 'Invalid repo format', prs: [] }, { status: 400 });
  }

  try {
    const openJson = execSync(
      `gh pr list --repo ${repo} --state open --limit 10 --json number,title,state,author,headRefName,additions,deletions,changedFiles,createdAt,labels`,
      { encoding: 'utf-8', timeout: 15000 },
    );

    const closedJson = execSync(
      `gh pr list --repo ${repo} --state closed --limit 10 --json number,title,state,author,headRefName,additions,deletions,changedFiles,createdAt,labels`,
      { encoding: 'utf-8', timeout: 15000 },
    );

    const open = JSON.parse(openJson);
    const closed = JSON.parse(closedJson);
    const all = [...open, ...closed];

    return NextResponse.json({ prs: all, repo });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, prs: [], repo }, { status: 200 });
  }
}
