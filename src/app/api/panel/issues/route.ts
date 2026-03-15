export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO = process.env.CORTEX_IDE_REVIEW_REPO || 'hurttlocker/cortex-ide';

export async function GET() {
  try {
    const { stdout } = await execFileAsync('gh', [
      'issue', 'list',
      '--repo', REPO,
      '--state', 'open',
      '--limit', '15',
      '--json', 'number,title,labels,state',
    ], { timeout: 15_000 });

    const issues = JSON.parse(stdout || '[]');
    return NextResponse.json({ issues });
  } catch {
    return NextResponse.json({ issues: [] });
  }
}
