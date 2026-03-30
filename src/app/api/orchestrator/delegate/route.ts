import { NextRequest, NextResponse } from 'next/server';
import { dispatch } from '@/lib/lane/commands';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { invalidateInboxCache } from '@/lib/mobile/inbox';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/orchestrator/delegate
 *
 * Orchestrator delegation endpoint — creates a lane and launches a Codex
 * session in one step. This ensures all delegated agent work gets governance
 * coverage through the lane command bus and policy engine.
 *
 * Body: { prompt, repoPath, taskName?, isolate? }
 * Returns: { ok, laneId, surfaceId, worktreePath, note, approvalId? }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }

  const prompt = (body.prompt as string)?.trim();
  const repoPath = (body.repoPath as string)?.trim();
  const taskName = (body.taskName as string)?.trim() || prompt?.slice(0, 60);
  const isolate = body.isolate !== false; // Default true for delegated work

  if (!prompt) {
    return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });
  }
  if (!repoPath) {
    return NextResponse.json({ ok: false, error: 'repoPath is required' }, { status: 400 });
  }

  // Generate a branch name from the task
  const slug = taskName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const hash = createHash('sha256').update(`${prompt}-${Date.now()}`).digest('hex').slice(0, 6);
  const branch = isolate ? `agent/${slug}-${hash}` : 'main';

  try {
    // Step 1: Open a lane
    const laneResult = await dispatch({
      verb: 'open_lane',
      repoPath,
      branch,
      runtime: 'codex',
      label: taskName,
      actor: 'orchestrator',
    });

    if (!laneResult.ok || !laneResult.laneId) {
      return NextResponse.json({
        ok: false,
        error: laneResult.note || 'Failed to open lane',
      }, { status: 422 });
    }

    const laneId = laneResult.laneId;

    // Step 2: Launch a session in the lane
    const launchResult = await dispatch({
      verb: 'launch_session',
      laneId,
      prompt,
      actor: 'orchestrator',
    });

    // If launch requires approval (policy gate), return the approval info
    if (launchResult.approvalId) {
      return NextResponse.json({
        ok: false,
        laneId,
        approvalId: launchResult.approvalId,
        note: launchResult.note,
      }, { status: 202 });
    }

    if (!launchResult.ok) {
      return NextResponse.json({
        ok: false,
        laneId,
        error: launchResult.note || 'Failed to launch session',
      }, { status: 422 });
    }

    // Broadcast the delegation event
    invalidateCommandCenterSnapshotCaches();
    invalidateInboxCache();
    await publishRealtimeMutation({
      mutation: {
        mutationId: `delegate-${laneId}-${Date.now()}`,
        source: 'desktop',
        action: 'launch',
        runtime: 'codex',
        surfaceId: launchResult.lane?.sessionKey || laneId,
        sessionKey: launchResult.lane?.sessionKey || laneId,
        status: 'queued',
        note: `Delegated: ${taskName}`,
        createdAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      },
      refreshTargets: ['global', 'mobileInbox'],
      sessionKeys: launchResult.lane?.sessionKey ? [launchResult.lane.sessionKey] : [],
      fresh: true,
    });

    return NextResponse.json({
      ok: true,
      laneId,
      surfaceId: launchResult.lane?.sessionKey || null,
      worktreePath: launchResult.lane?.worktreePath || null,
      branch,
      note: launchResult.note,
    });
  } catch (err) {
    console.error('[orchestrator-delegate]', err instanceof Error ? err.message : err);
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : 'Delegation failed',
    }, { status: 500 });
  }
}
