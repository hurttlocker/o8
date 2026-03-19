import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function gh(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec('gh', args, {
    cwd,
    timeout: 15_000,
    env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' },
  });
  return stdout.trim();
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body?.repo || !body?.number || !body?.action) {
    return NextResponse.json({ error: 'repo, number, and action required' }, { status: 400 });
  }

  const { repo, number, action, comment } = body;

  try {
    switch (action) {
      case 'approve':
        await gh(['pr', 'review', String(number), '--approve', ...(comment ? ['--body', comment] : [])], repo);
        return NextResponse.json({ ok: true, action: 'approved' });

      case 'request_changes':
        if (!comment) {
          return NextResponse.json({ error: 'Comment required for request_changes' }, { status: 400 });
        }
        await gh(['pr', 'review', String(number), '--request-changes', '--body', comment], repo);
        return NextResponse.json({ ok: true, action: 'changes_requested' });

      case 'comment':
        if (!comment) {
          return NextResponse.json({ error: 'Comment text required' }, { status: 400 });
        }
        await gh(['pr', 'comment', String(number), '--body', comment], repo);
        return NextResponse.json({ ok: true, action: 'commented' });

      case 'merge':
        await gh(['pr', 'merge', String(number), '--squash', '--delete-branch'], repo);
        return NextResponse.json({ ok: true, action: 'merged' });

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : `${action} failed` },
      { status: 500 },
    );
  }
}
