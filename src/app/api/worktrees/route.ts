/**
 * Worktree API Routes
 *
 * GET  /api/worktrees?repo=<path>    — List all worktrees + conflict status
 * POST /api/worktrees                — Create a new worktree
 * DELETE /api/worktrees              — Cleanup/prune worktrees
 *
 * @see https://github.com/hurttlocker/o8/issues/67
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getWorktreeManager, getActiveWorktreeSummary } from '@/lib/worktree/launch';
import { isRepoWorkspaceIsolationPreference, type RepoSetupEnvMode } from '@/lib/repos/types';
import type { WorkspaceIsolationPreference } from '@/lib/worktree/types';

// ── GET: List worktrees + conflicts ──

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
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
  branchName?: string;
  baseBranch?: string;
  managed?: boolean;
  skipSetup?: boolean;
  envMode?: RepoSetupEnvMode;
  envFiles?: string[];
  isolationPreference?: unknown;
}

export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
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

  let isolationPreference: WorkspaceIsolationPreference | undefined;
  if (body.isolationPreference !== undefined) {
    if (!isRepoWorkspaceIsolationPreference(body.isolationPreference)) {
      return NextResponse.json({ error: 'Invalid isolationPreference.' }, { status: 400 });
    }
    isolationPreference = body.isolationPreference;
  }

  try {
    const mgr = getWorktreeManager(body.repo);
    const worktree = await mgr.create({
      agentType: body.agentType,
      taskName: body.taskName,
      branchName: body.branchName,
      baseBranch: body.baseBranch,
      // This route promises a created o8 workspace. External-runtime metadata
      // registration is a separate lifecycle and must not masquerade as 201.
      managed: true,
      skipSetup: body.skipSetup,
      envMode: body.envMode,
      envFiles: body.envFiles,
      isolationPreference,
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
  const denied = requirePanelAuth(req);
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

      const cleaned = await mgr.cleanup(body.worktreeId, {
        force: body.force,
        deleteBranch: body.deleteBranch,
      });
      if (!cleaned) {
        return NextResponse.json({
          ok: false,
          error: {
            code: 'cleanup_refused',
            message: 'Worktree cleanup was refused; its durable ownership was retained.',
          },
          worktreeId: body.worktreeId,
        }, { status: 409 });
      }

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
