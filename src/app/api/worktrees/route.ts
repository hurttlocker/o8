/**
 * Worktree API Routes
 *
 * GET  /api/worktrees?repo=<path>    — List all worktrees + conflict status
 * POST /api/worktrees                — Create a new worktree
 * DELETE /api/worktrees              — Cleanup/prune worktrees
 *
 * @see https://github.com/hurttlocker/cortex-ide/issues/67
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { getWorktreeManager, getActiveWorktreeSummary } from '@/lib/worktree/launch';

const API_TOKEN = process.env.WS_TOKEN ?? 'cortex-ide';

function isTrustedPanelRequest(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (origin && origin === req.nextUrl.origin) {
    return true;
  }

  return req.headers.get('sec-fetch-site') === 'same-origin';
}

function checkAuth(req: NextRequest): NextResponse | null {
  if (isTrustedPanelRequest(req)) {
    return null;
  }

  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : req.nextUrl.searchParams.get('token');
  if (token !== API_TOKEN) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

// ── GET: List worktrees + conflicts ──

export async function GET(req: NextRequest) {
  const denied = checkAuth(req);
  if (denied) return denied;

  const repo = req.nextUrl.searchParams.get('repo');
  if (!repo) {
    return NextResponse.json({ error: 'repo parameter required' }, { status: 400 });
  }

  try {
    const summary = await getActiveWorktreeSummary(repo);
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

// ── POST: Create worktree ──

interface CreateBody {
  repo: string;
  agentType: string;
  taskName: string;
  baseBranch?: string;
  skipSetup?: boolean;
}

export async function POST(req: NextRequest) {
  const denied = checkAuth(req);
  if (denied) return denied;

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.repo || !body.agentType || !body.taskName) {
    return NextResponse.json(
      { error: 'repo, agentType, and taskName are required' },
      { status: 400 },
    );
  }

  try {
    const mgr = getWorktreeManager(body.repo);
    const worktree = await mgr.create({
      agentType: body.agentType,
      taskName: body.taskName,
      baseBranch: body.baseBranch,
      skipSetup: body.skipSetup,
    });

    return NextResponse.json({ worktree }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

// ── DELETE: Cleanup or prune ──

interface DeleteBody {
  repo: string;
  worktreeId?: string;
  action: 'cleanup' | 'prune';
  force?: boolean;
  deleteBranch?: boolean;
  maxAgeMs?: number;
}

export async function DELETE(req: NextRequest) {
  const denied = checkAuth(req);
  if (denied) return denied;

  let body: DeleteBody;
  try {
    body = (await req.json()) as DeleteBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.repo || !body.action) {
    return NextResponse.json(
      { error: 'repo and action are required' },
      { status: 400 },
    );
  }

  const mgr = getWorktreeManager(body.repo);

  try {
    if (body.action === 'prune') {
      const pruned = await mgr.prune(body.maxAgeMs);
      return NextResponse.json({ pruned, count: pruned.length });
    }

    if (body.action === 'cleanup') {
      if (!body.worktreeId) {
        return NextResponse.json({ error: 'worktreeId required for cleanup' }, { status: 400 });
      }

      await mgr.cleanup(body.worktreeId, {
        force: body.force,
        deleteBranch: body.deleteBranch,
      });

      return NextResponse.json({ ok: true, cleaned: body.worktreeId });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
