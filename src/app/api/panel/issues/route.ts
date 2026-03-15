export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_REPO = process.env.CORTEX_IDE_REVIEW_REPO || 'hurttlocker/cortex-ide';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repo = searchParams.get('repo') || DEFAULT_REPO;

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ error: 'Invalid repo format', issues: [] }, { status: 400 });
  }

  try {
    const { stdout } = await execFileAsync('gh', [
      'issue', 'list',
      '--repo', repo,
      '--state', 'open',
      '--limit', '15',
      '--json', 'number,title,labels,state',
    ], { timeout: 15_000 });

    const issues = JSON.parse(stdout || '[]');
    return NextResponse.json({ issues, repo });
  } catch {
    return NextResponse.json({ issues: [], repo });
  }
}
