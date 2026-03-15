/**
 * Worktree Conflicts API
 *
 * GET  /api/worktrees/conflicts?repo=<path>&deep=true  — Enhanced conflict report
 *
 * Fast mode (default): file-level overlap scan, <100ms
 * Deep mode (?deep=true): line-level analysis on all overlaps, 500ms-2s
 *
 * @see https://github.com/hurttlocker/cortex-ide/issues/69
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { getWorktreeManager } from '@/lib/worktree/launch';
import { generateConflictReport } from '@/lib/worktree/conflicts';

const API_TOKEN = process.env.WS_TOKEN ?? 'cortex-ide';

function checkAuth(req: NextRequest): NextResponse | null {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : req.nextUrl.searchParams.get('token');
  if (token !== API_TOKEN) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const denied = checkAuth(req);
  if (denied) return denied;

  const repo = req.nextUrl.searchParams.get('repo');
  if (!repo) {
    return NextResponse.json({ error: 'repo parameter required' }, { status: 400 });
  }

  const deep = req.nextUrl.searchParams.get('deep') === 'true';

  try {
    const mgr = getWorktreeManager(repo);
    const worktrees = await mgr.list();
    const report = await generateConflictReport(worktrees, deep);

    return NextResponse.json(report, {
      headers: {
        'Cache-Control': 'no-cache, no-store',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
