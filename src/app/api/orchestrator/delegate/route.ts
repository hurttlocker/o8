import { NextRequest, NextResponse } from 'next/server';
import { dispatch } from '@/lib/lane/commands';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { invalidateInboxCache } from '@/lib/mobile/inbox';
import { createHash, randomUUID } from 'node:crypto';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/orchestrator/delegate
 *
 * Orchestrator delegation endpoint — creates a packet shell, opens a lane
 * linked to that packet, and launches a Codex session in one step. Every
 * delegated lane gets a real packetId so approve_and_merge, cortex_steer_agent,
 * reset_packet, and the whole governance toolchain work on it without the
 * orchestrator having to fall back to raw git commands.
 *
 * Body: { prompt, repoPath, taskName?, isolate? }
 * Returns: { ok, laneId, packetId, surfaceId, worktreePath, note, approvalId? }
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
    // Step 1: Synthesize a packet shell in the orchestrator control plane
    // so every downstream governance tool (approve_and_merge, reset_packet,
    // cortex_steer_agent, submit_review) can find this work by packetId.
    // Without this, delegate-dispatched lanes are second-class citizens and
    // force the orchestrator to fall back to raw Bash/git, which is slow
    // and hides state from the UI.
    const packetId = `pkt-${randomUUID()}`;
    const now = new Date().toISOString();
    const packet: OrchestratorPacket = {
      id: packetId,
      referenceLabel: `D${Date.now().toString(36).slice(-4).toUpperCase()}`,
      title: taskName,
      summary: prompt,
      workspaceTargetPath: repoPath,
      branchTarget: branch,
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'running',
      releaseState: 'pending',
      status: 'running',
      attemptCount: 1,
      maxAttempts: 3,
      blockedReason: null,
      lastEventAt: now,
      lastEventLabel: 'delegate_dispatched',
      archivedAt: null,
      review: null,
      lane: null,
    };

    const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import(
      '@/lib/orchestrator/control-plane'
    );
    const existing = readOrchestratorControlPlaneState();
    writeOrchestratorControlPlaneState({
      ...existing,
      version: 2,
      missionId: existing.missionId || `delegate-${Date.now().toString(36)}`,
      prompt: existing.prompt || `Delegated work: ${taskName}`,
      summary: existing.summary || `Delegate dispatches routed through /api/orchestrator/delegate.`,
      repoPath: existing.repoPath || repoPath,
      runtime: existing.runtime || 'codex',
      constraints: existing.constraints || '',
      packets: [...existing.packets, packet],
      updatedAt: now,
    });

    // Step 2: Open a lane bound to the synthesized packet
    const laneResult = await dispatch({
      verb: 'open_lane',
      repoPath,
      branch,
      runtime: 'codex',
      label: taskName,
      packetId,
      actor: 'orchestrator',
    });

    if (!laneResult.ok || !laneResult.laneId) {
      return NextResponse.json({
        ok: false,
        packetId,
        error: laneResult.note || 'Failed to open lane',
      }, { status: 422 });
    }

    const laneId = laneResult.laneId;

    // Step 3: Launch a session in the lane
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
        packetId,
        approvalId: launchResult.approvalId,
        note: launchResult.note,
      }, { status: 202 });
    }

    if (!launchResult.ok) {
      return NextResponse.json({
        ok: false,
        laneId,
        packetId,
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
      packetId,
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
