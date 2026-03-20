export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repo = searchParams.get('repo');

  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: 'Invalid repo format', prs: [] }, { status: 400 });
  }

  try {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'list',
      '--repo', repo,
      '--state', 'open',
      '--limit', '10',
      '--json', 'number,title,author,headRefName,baseRefName,state,additions,deletions,changedFiles,statusCheckRollup,reviewDecision,url,createdAt',
    ], { timeout: 15_000, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' } });

    const prs = JSON.parse(stdout || '[]');
    return NextResponse.json({ prs, repo });
  } catch {
    return NextResponse.json({ prs: [], repo });
  }
}
