import { NextRequest, NextResponse } from 'next/server';
import { dispatch } from '@/lib/lane/commands';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { invalidateInboxCache } from '@/lib/mobile/inbox';
import { createHash } from 'node:crypto';
import { surfaceEdgeCases } from '@/lib/dispatch/edge-case-surfacer';
import { computeReadBudget, resolveModelTier } from '@/lib/dispatch/read-budget';
import { computePredictedFiles } from '@/lib/orchestrator/preservation-envelope';
import { normalizeRequestedRuntime, resolveWorkerRouting } from '@/lib/agents/routing';
import { codename } from '@/lib/agents/codename';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { resolveSubscriptionProfileRouting } from '@/lib/operator/subscription-profile';
import { resolveWorkerHuddle } from '@/lib/operator/worker-start-mode';
import { buildProjectTaskBrief, getProjectContext } from '@/lib/projects/context';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { buildProjectBriefPromptV1 } from '@/lib/prompts/v1';
import { MODEL_IDS } from '@/lib/models';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { listLanes } from '@/lib/lane/registry';
import {
  buildPacketSelfReviewInstructions,
  buildReadOnlyPacketSelfReviewInstructions,
} from '@/lib/orchestrator/self-review';

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
 * Body: { prompt, repoPath, taskName?, isolate?, baseBranch? }
 *   baseBranch — the branch the new lane should fork from (default: 'main').
 *     Used by fix dispatches that need to resume work against a feature
 *     branch whose diff exists only on that branch. See #530 Option A.
 * Returns: { ok, laneId, packetId, surfaceId, worktreePath, note, approvalId?, baseBranch }
 *
 * Note on #530 follow-ups: Options B (dedicated `resume` verb for
 * existing lanes) and C (fix `cortex_steer_agent` at its root) are
 * deferred — track them in a follow-up issue. Option A ships here as
 * the quickest unlock for medium (5–50-edit) fix dispatches.
 */
async function performDelegate(request: NextRequest, clientMutationId: string) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }

  const prompt = (body.prompt as string)?.trim();
  const repoPath = (body.repoPath as string)?.trim();
  const taskName = (body.taskName as string)?.trim() || prompt?.slice(0, 60);
  const isolate = body.isolate !== false; // Default true for delegated work
  const readOnly = body.readOnly === true;

  // #530 — Option A. Caller may override the base branch so a fix dispatch
  // forks off a feature branch instead of main. Absent / blank → 'main' so
  // existing callers behave identically.
  const baseBranchRaw = typeof body.baseBranch === 'string' ? body.baseBranch.trim() : '';
  const baseBranch = baseBranchRaw || 'main';

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
  const hash = createHash('sha256').update(`${prompt}-${clientMutationId}`).digest('hex').slice(0, 6);
  // When not isolating we just write directly onto the caller's baseBranch
  // (typically 'main'). When isolating we fork a fresh agent/* branch from
  // baseBranch — the lane command carries baseBranch through to the
  // worktree manager so `git worktree add -b <branch> origin/<baseBranch>`
  // uses the right starting point.
  const branch = isolate ? `agent/${slug}-${hash}` : baseBranch;

  try {
    // Step 1: Synthesize a packet shell in the orchestrator control plane
    // so every downstream governance tool (approve_and_merge, reset_packet,
    // cortex_steer_agent, submit_review) can find this work by packetId.
    // Without this, delegate-dispatched lanes are second-class citizens and
    // force the orchestrator to fall back to raw Bash/git, which is slow
    // and hides state from the UI.
    const packetId = `pkt-delegate-${createHash('sha256').update(clientMutationId).digest('hex').slice(0, 16)}`;
    const now = new Date().toISOString();
    const defaults = getOperatorDefaultsSync().values;
    const runtimeWasProvided = body.runtime !== undefined && body.runtime !== null && body.runtime !== '';
    const explicitRuntime = normalizeRequestedRuntime(body.runtime);
    if (runtimeWasProvided && !explicitRuntime) {
      return NextResponse.json({ ok: false, error: `Unsupported worker runtime: ${String(body.runtime)}` }, { status: 400 });
    }
    const defaultRuntime = defaults.subscriptionProfile === 'both'
      ? defaults.defaultDispatchRuntime
      : null;
    const requestedRuntime = runtimeWasProvided ? explicitRuntime : defaultRuntime;
    const explicitModel = typeof body.model === 'string' && body.model.trim()
      ? body.model.trim()
      : null;
    const runtimePinnedModel = requestedRuntime === 'opencode'
      ? defaults.opencodeWorkerModel ?? MODEL_IDS.opencodeDefault
      : null;
    const profileRouting = resolveSubscriptionProfileRouting({
      profile: defaults.subscriptionProfile,
      requestedRuntime,
      requestedModel: explicitModel ?? runtimePinnedModel,
      defaultDispatchModel: defaults.defaultDispatchModel,
    });
    if (!profileRouting.ok) {
      return NextResponse.json({ ok: false, error: profileRouting.message, code: profileRouting.code }, { status: 400 });
    }
    const workerRouting = resolveWorkerRouting({
      workerIntent: body.workerIntent,
      requestedProvider: body.requestedProvider,
      requestedRuntime: profileRouting.requestedRuntime,
      requestedModel: profileRouting.requestedModel,
      source: 'delegate-api',
    });
    const huddle = resolveWorkerHuddle({
      mode: defaults.workerStartMode,
      explicitHuddle: typeof body.huddle === 'boolean' ? body.huddle : undefined,
      profile: defaults.subscriptionProfile,
      runtime: workerRouting.selectedRuntime,
      model: workerRouting.selectedModel,
    });

    // #535 — Compute a read budget at dispatch time so weaker models don't
    // start writing before reading the adjacent surface. The helper returns
    // null when no budget is warranted (empty targets / strong tier w/ no
    // graph), which preserves legacy behaviour for delegate callers.
    const predictedFiles = computePredictedFiles({
      workspaceTargetPath: repoPath,
      title: taskName,
      summary: prompt,
    } as OrchestratorPacket);
    const modelTier = resolveModelTier({
      runtime: workerRouting.selectedRuntime,
      assignedModel: workerRouting.selectedModel,
    });
    const readBudget = computeReadBudget({
      repoPath,
      targetFiles: predictedFiles,
      tier: modelTier,
    }) ?? undefined;

    // #536 — Edge-case surfacer — never throws, returns { sites: [] } on
    // garbage input so the packet shape stays legal.
    const edgeCaseResult = surfaceEdgeCases({
      repoPath,
      targetFiles: predictedFiles,
      depth: 1,
    });
    const edgeCaseSites = edgeCaseResult.sites.length > 0 ? edgeCaseResult.sites : undefined;
    const projectContext = await getProjectContext({ repoPath });
    const projectBrief = buildProjectTaskBrief(projectContext, {
      repoPath,
      taskTitle: taskName,
      taskBody: prompt,
    });
    const launchPrompt = buildProjectBriefPromptV1(projectBrief, prompt);
    const launchContext = {
      source: 'agent' as const,
      presentation: 'split' as const,
      repoContext: projectContext.repoInProject ? 'registered' as const : 'transient' as const,
      workMode: readOnly ? 'read-only' as const : 'edit' as const,
      caller: 'orchestrator',
    };

    const packet: OrchestratorPacket = {
      id: packetId,
      referenceLabel: `D${Date.now().toString(36).slice(-4).toUpperCase()}`,
      title: taskName,
      summary: prompt,
      workspaceTargetPath: repoPath,
      branchTarget: branch,
      runtime: workerRouting.selectedRuntime,
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'queued',
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
      assignedModel: workerRouting.selectedModel,
      predictedFiles: predictedFiles.length > 0 ? predictedFiles : undefined,
      readBudget,
      edgeCaseSites,
      workerIntent: workerRouting.workerIntent,
      workerRouting,
      huddle,
      prompt: launchPrompt,
      launchContext,
    };

    const completionContract = readOnly
      ? [
          'Read-only packet: inspect the repository and report the requested findings. Do not edit files, create commits, create branches, or run commands that mutate repository state. A clean zero-diff completion is the expected successful outcome.',
          ...buildReadOnlyPacketSelfReviewInstructions(),
        ]
      : [
          ...buildPacketSelfReviewInstructions(baseBranch),
          'CRITICAL: Before reporting completion, commit all changes with a descriptive message. Uncommitted changes will be lost when the isolated worktree is cleaned up.',
        ];
    const governedLaunchPrompt = [launchPrompt, ...completionContract].join('\n\n');

    // Append the packet by MUTATING the state object passed into the
    // withLockedState callback. Critical: do NOT call writeOrchestratorControlPlaneState
    // from inside the callback — withLockedState's post-callback reconcile uses
    // the ORIGINAL `current` reference and writes that, which would clobber any
    // direct write we made ourselves. Mutation is the working pattern because
    // reconcile re-reads the mutated fields from the same object.
    const { withLockedState } = await import('@/lib/orchestrator/control-plane');
    await withLockedState((current) => {
      if (!current.packets.some((candidate) => candidate.id === packet.id)) current.packets.push(packet);
      if (!current.missionId) current.missionId = `delegate-${Date.now().toString(36)}`;
      if (!current.prompt) current.prompt = `Delegated work: ${taskName}`;
      if (!current.summary) current.summary = `Delegate dispatches routed through /api/orchestrator/delegate.`;
      if (!current.repoPath) current.repoPath = repoPath;
      if (!current.runtime) current.runtime = workerRouting.selectedRuntime;
      current.updatedAt = now;
    });

    // Step 2: Open a lane bound to the synthesized packet. #530 — pass the
    // resolved baseBranch through so fix dispatches can fork from a feature
    // branch rather than main.
    const laneResult = await dispatch({
      verb: 'open_lane',
      repoPath,
      branch,
      baseBranch,
      runtime: workerRouting.selectedRuntime,
      projectId: projectContext.id,
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
      prompt: governedLaunchPrompt,
      model: workerRouting.selectedModel ?? undefined,
      clientMutationId,
      launchContext,
      actor: 'orchestrator',
    });

    // If launch requires approval (policy gate), return the approval info
    if (launchResult.approvalId) {
      return NextResponse.json({
        ok: true,
        status: 'pending_approval',
        laneId,
        packetId,
        codename: codename(laneId),
        approvalId: launchResult.approvalId,
        note: launchResult.note,
      }, { status: 200 });
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
        runtime: workerRouting.selectedRuntime,
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
      // The canvas card labels this lane `codename(laneId)` (deterministic,
      // codename.ts is the single source of truth) — return it so voice
      // surfaces announce the SAME name the operator sees on the card.
      codename: codename(laneId),
      surfaceId: launchResult.lane?.sessionKey || null,
      worktreePath: launchResult.lane?.worktreePath || null,
      branch,
      baseBranch,
      workerRouting,
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

export async function POST(request: NextRequest) {
  const body = await request.clone().json().catch(() => null) as Record<string, unknown> | null;
  const clientMutationId = typeof body?.clientMutationId === 'string'
    ? body.clientMutationId.trim()
    : '';
  if (!clientMutationId) {
    return NextResponse.json({ ok: false, error: 'clientMutationId is required' }, { status: 400 });
  }
  const canonicalBody = JSON.stringify({
    prompt: typeof body?.prompt === 'string' ? body.prompt.trim() : '',
    repoPath: typeof body?.repoPath === 'string' ? body.repoPath.trim() : '',
    taskName: typeof body?.taskName === 'string' ? body.taskName.trim() : '',
    isolate: body?.isolate !== false,
    baseBranch: typeof body?.baseBranch === 'string' ? body.baseBranch.trim() : '',
    runtime: body?.runtime ?? null,
    model: body?.model ?? null,
    workerIntent: body?.workerIntent ?? null,
    requestedProvider: body?.requestedProvider ?? null,
    huddle: body?.huddle ?? null,
    readOnly: body?.readOnly === true,
  });
  const binding = bindIdempotencyClientMutation({
    namespace: 'orchestrator_delegate',
    clientKey: clientMutationId,
    body: canonicalBody,
  });
  if (binding.status === 'conflict') {
    return NextResponse.json({ ok: false, error: 'clientMutationId was used for another delegation' }, { status: 409 });
  }
  if (binding.status === 'unavailable') {
    return NextResponse.json({ ok: false, error: 'The delegation receipt store is unavailable' }, { status: 503 });
  }
  const packetId = `pkt-delegate-${createHash('sha256').update(clientMutationId).digest('hex').slice(0, 16)}`;
  const responseReceipt = async () => {
    const response = await performDelegate(new NextRequest(request.clone()), clientMutationId);
    return { status: response.status, payload: await response.json() as Record<string, unknown> };
  };
  const outcome = await withIdempotency({
    key: deriveIdempotencyKey({
      verb: 'orchestrator_delegate',
      scopeId: String(body?.repoPath ?? ''),
      clientKey: clientMutationId,
      body: canonicalBody,
    }),
    verb: 'orchestrator_delegate',
    scopeId: String(body?.repoPath ?? ''),
    reconcileUnresolved: async () => {
      const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId);
      const lane = listLanes().find((candidate) => candidate.packetId === packetId && candidate.sessionKey);
      if (!packet || !lane?.sessionKey) return null;
      return {
        status: 200,
        payload: {
          ok: true,
          laneId: lane.id,
          packetId,
          codename: codename(lane.id),
          surfaceId: lane.sessionKey,
          worktreePath: lane.worktreePath,
          branch: lane.branch,
          baseBranch: lane.baseBranch,
          note: 'Recovered the delegated worker from its durable packet and lane binding.',
        },
      };
    },
  }, responseReceipt);
  if (outcome.inProgress) {
    if (outcome.unresolved) {
      return NextResponse.json({
        ok: false,
        error: 'outcome_unknown',
        outcomeUnknown: true,
        note: 'The prior delegated launch process ended before its receipt was persisted. The outcome is unknown, so the exact mutation remains quarantined and was not repeated. Inspect the packet and lane before taking another action.',
      }, { status: 409 });
    }
    return NextResponse.json({ ok: true, inProgress: true, status: 'in_progress' }, { status: 202 });
  }
  return NextResponse.json({
    ...outcome.result.payload,
    replayed: outcome.replayed || undefined,
  }, { status: outcome.result.status });
}
