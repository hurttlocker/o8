export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_REPO = process.env.CORTEX_IDE_REVIEW_REPO || 'hurttlocker/cortex-ide';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
  const { number: num } = await params;
  const { searchParams } = new URL(request.url);
  const REPO = searchParams.get('repo') || DEFAULT_REPO;
  const issueNumber = parseInt(num, 10);

  if (!Number.isFinite(issueNumber) || issueNumber < 1) {
    return NextResponse.json({ error: 'Invalid issue number' }, { status: 400 });
  }

  try {
    const { stdout } = await execFileAsync('gh', [
      'issue', 'view',
      String(issueNumber),
      '--repo', REPO,
      '--json', 'number,title,body,state,labels,author,createdAt,comments,url',
    ], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });

    const raw = JSON.parse(stdout || '{}');

    const issue = {
      number: raw.number,
      title: raw.title ?? '',
      body: raw.body ?? '',
      state: raw.state ?? 'OPEN',
      labels: (raw.labels ?? []).map((l: { name: string; color: string }) => ({
        name: l.name,
        color: l.color,
      })),
      author: raw.author?.login ?? 'unknown',
      createdAt: raw.createdAt ?? '',
      comments: Array.isArray(raw.comments) ? raw.comments.length : (raw.comments ?? 0),
      url: raw.url ?? '',
    };

    return NextResponse.json({ issue });
  } catch {
    return NextResponse.json({ error: 'Issue not found' }, { status: 404 });
  }
}
