import { NextRequest, NextResponse } from 'next/server';
import {
  resolveRequestPrincipal,
  resolveRequestPrincipalContext,
  workerPacketRefusal,
} from '@/lib/auth/principal';
import { applyApprovedFileEdit } from '@/lib/approvals/file-edit';
import { applyApprovedSpecUpdate } from '@/lib/approvals/spec-update';
import { verifySpokenReviewMutationEvidence } from '@/lib/approvals/spoken-review-guard';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { rejectLlmApproval, resumeLlmApproval } from '@/lib/approvals/llm';
import {
  claimApprovalResolution,
  finalizeApprovalContinuation,
  reopenApprovalAfterEvidenceDrift,
} from '@/lib/approvals/resolution';
import {
  createApproval,
  createTestApproval,
  getApproval,
  listApprovals,
  listApprovalsForContext,
  listUnsettledApprovalContinuations,
} from '@/lib/approvals/store';
import type { CreateApprovalInput } from '@/lib/approvals/types';
import { launchRuntimeSurface } from '@/lib/runtime/actions';
import type { RuntimeId } from '@/lib/runtimes';
import { getRuntime } from '@/lib/runtimes/registry';
import { invalidateInboxCache } from '@/lib/mobile/inbox';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { findLaneBySession, getLane } from '@/lib/lane/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function invalidateApprovalCaches() {
  invalidateCommandCenterSnapshotCaches();
  invalidateInboxCache();
}

function mergeDecisionNotes(...notes: Array<string | null | undefined>) {
  return notes
    .map((note) => note?.trim())
    .filter((note): note is string => Boolean(note))
    .join(' ');
}

/**
 * A stored `diff` preview averages ~12KB per approval, so a broad list of a real
 * machine's history carries megabytes of diffs nothing on screen reads — measured
 * 2026-07-29: `?status=all` returned 7.9MB across 468 rows, 5.6MB of it diffs, and four
 * separate pollers request it during a single dashboard boot. List callers render
 * summaries; the diff belongs to the surface that opens one approval. Context queries
 * (packetId / laneId) keep it, since those ARE the detail lookups, and any caller can ask
 * for it explicitly with `include=diff`.
 */
function stripDiffPreviews<T extends { diff?: unknown }>(approvals: T[]): T[] {
  return approvals.map(({ diff: _diff, ...rest }) => rest as T);
}

/**
 * GET /api/panel/approvals — list pending approvals from the shared queue.
 */
export async function GET(request: NextRequest) {
  const sessionKey = request.nextUrl.searchParams.get('sessionKey')?.trim() || undefined;
  const packetId = request.nextUrl.searchParams.get('packetId')?.trim() || undefined;
  const laneId = request.nextUrl.searchParams.get('laneId')?.trim() || undefined;
  const statusParam = request.nextUrl.searchParams.get('status')?.trim() || 'pending';
  const status = statusParam === 'all' ? 'all' : 'pending';
  const isContextQuery = Boolean(packetId || laneId);
  const includeDiff = request.nextUrl.searchParams.get('include')?.trim() === 'diff';
  const ownershipRefusal = workerPacketRefusal(
    resolveRequestPrincipalContext(request),
    packetId || (laneId ? getLane(laneId)?.packetId : null) || (sessionKey ? findLaneBySession(sessionKey)?.packetId : null),
  );
  if (ownershipRefusal) {
    return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
  }
  const approvals = isContextQuery
    ? listApprovalsForContext({ packetId, laneId, sessionKey })
      .filter((approval) => status === 'all' || approval.status === status)
    : status === 'pending'
      ? [
          ...listApprovals({ status, sessionKey }),
          ...listUnsettledApprovalContinuations({ sessionKey }),
        ]
      : listApprovals({ status, sessionKey });

  return NextResponse.json({
    approvals: (isContextQuery || includeDiff) ? approvals : stripDiffPreviews(approvals),
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

/**
 * POST /api/panel/approvals — create test approval or resolve a shared approval.
 *
 * Create: { action: 'create', approval: CreateApprovalInput }
 * Create test: { action: 'test', sessionKey?: string }
 * Resolve: { action: 'approve' | 'reject', id: string, editedCommand?: string }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = typeof body.action === 'string' ? body.action : '';

  if (action === 'create') {
    const approvalBody = (body.approval && typeof body.approval === 'object'
      ? body.approval
      : null) as Partial<CreateApprovalInput> | null;
    if (!approvalBody) {
      return NextResponse.json({ ok: false, error: 'Approval payload is required' }, { status: 400 });
    }

    try {
      const approval = createApproval({
        projectId: typeof approvalBody.projectId === 'string' ? approvalBody.projectId : undefined,
        source: approvalBody.source === 'llm-chat' || approvalBody.source === 'test' ? approvalBody.source : 'runtime',
        runtime: typeof approvalBody.runtime === 'string' ? approvalBody.runtime : 'claude-code',
        agent: typeof approvalBody.agent === 'string' ? approvalBody.agent : 'Runtime Hook',
        sessionKey: typeof approvalBody.sessionKey === 'string' ? approvalBody.sessionKey : 'runtime:hook',
        title: typeof approvalBody.title === 'string' ? approvalBody.title : 'Approval required',
        description: typeof approvalBody.description === 'string' ? approvalBody.description : 'Approval required',
        summary: typeof approvalBody.summary === 'string' ? approvalBody.summary : 'Approval required',
        toolName: typeof approvalBody.toolName === 'string' ? approvalBody.toolName : undefined,
        args: approvalBody.args && typeof approvalBody.args === 'object' ? approvalBody.args : undefined,
        command: typeof approvalBody.command === 'string' ? approvalBody.command : undefined,
        editable: typeof approvalBody.editable === 'boolean' ? approvalBody.editable : undefined,
        diff: approvalBody.diff && typeof approvalBody.diff === 'object' ? approvalBody.diff : undefined,
        risk: approvalBody.risk === 'high' || approvalBody.risk === 'medium' ? approvalBody.risk : 'low',
        metadata: approvalBody.metadata && typeof approvalBody.metadata === 'object'
          ? Object.fromEntries(Object.entries(approvalBody.metadata).map(([key, value]) => [key, String(value)]))
          : undefined,
        policyRuleId: typeof approvalBody.policyRuleId === 'string' ? approvalBody.policyRuleId : undefined,
        continuation: approvalBody.continuation,
      });

      invalidateApprovalCaches();
      await publishRealtimeMutation({
        mutation: {
          mutationId: `approval-create-${approval.id}`,
          source: 'desktop',
          action: 'approve',
          sessionKey: approval.sessionKey,
          surfaceId: approval.sessionKey,
          status: 'pending',
          note: `Approval requested: ${approval.title}`,
          createdAt: new Date().toISOString(),
        },
        refreshTargets: ['global', 'mobileInbox'],
        sessionKeys: [approval.sessionKey],
        fresh: true,
      });

      return NextResponse.json({ ok: true, approval }, {
        status: 201,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    } catch (error) {
      console.error('[approvals] Failed to create approval:', error);
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : 'Failed to create approval' },
        { status: 500 },
      );
    }
  }

  if (action === 'test') {
    const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : undefined;
    const approval = createTestApproval(sessionKey);
    invalidateApprovalCaches();
    await publishRealtimeMutation({
      mutation: {
        mutationId: `approval-create-${approval.id}`,
        source: 'desktop',
        action: 'approve',
        sessionKey: approval.sessionKey,
        surfaceId: approval.sessionKey,
        status: 'pending',
        note: `Approval requested: ${approval.title}`,
        createdAt: new Date().toISOString(),
      },
      refreshTargets: ['global', 'mobileInbox'],
      sessionKeys: [approval.sessionKey],
      fresh: true,
    });
    return NextResponse.json({ ok: true, approval }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }

  if (action !== 'approve' && action !== 'reject') {
    return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
  }

  // Operator-only: a dispatched worker must NOT resolve approvals. Approving a
  // lane-merge continuation re-dispatches the merge as actor:'user', which skips
  // every governance gate (file-size, security/budget merge-gate, durable-review,
  // merge-policy). A worker self-approving its own card is the CRIT-1 moat
  // collapse. The worker presents O8_WORKER_TOKEN via its CLI; the operator
  // webview + orchestrator MCP never do. (SECURITY_AUDIT_2026-07-02 §CRIT-1.)
  const principal = resolveRequestPrincipal(request);
  if (principal !== 'operator' && principal !== 'device') {
    return NextResponse.json(
      { ok: false, error: 'Approvals are operator-only; a worker cannot resolve them.' },
      { status: 403, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) {
    return NextResponse.json({ ok: false, error: 'Approval id is required' }, { status: 400 });
  }

  const editedCommand = typeof body.editedCommand === 'string' ? body.editedCommand : undefined;
  const requestedStrategy = typeof body.strategy === 'string'
    && (body.strategy === 'ours' || body.strategy === 'theirs' || body.strategy === 'manual')
    ? body.strategy
    : undefined;
  const current = getApproval(id);
  if (!current) {
    return NextResponse.json({ ok: false, error: 'Approval not found' }, { status: 404 });
  }
  if (current.status !== 'pending') {
    return NextResponse.json({ ok: true, approval: current, resolved: action, note: 'Approval was already resolved.' }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }

  try {
    let spokenReviewEvidence;
    try {
      spokenReviewEvidence = await verifySpokenReviewMutationEvidence(
        body.spokenReviewEvidence,
        current,
      );
    } catch (error) {
      return NextResponse.json({
        ok: false,
        error: error instanceof Error ? error.message : 'Spoken review evidence is no longer current.',
        code: 'spoken_review_changed',
      }, {
        status: 409,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    if (
      spokenReviewEvidence
      && requestedStrategy !== undefined
      && current.continuation?.kind === 'lane'
      && requestedStrategy !== current.continuation.strategy
    ) {
      return NextResponse.json({
        ok: false,
        error: 'The selected merge strategy was not included in the spoken review. Review the packet again.',
        code: 'spoken_review_changed',
      }, {
        status: 409,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    const reviewedLaneStatus = current.continuation?.kind === 'lane'
      ? getLane(current.continuation.laneId)?.status
      : undefined;

    // resolveApproval is atomic in SQLite and guards against double-resolve.
    // Call it first so a concurrent request loses the race and short-circuits
    // before any file mutation occurs (close TOCTOU window).
    const resolutionClaim = claimApprovalResolution(
      id,
      action,
      'desktop',
      undefined,
      current.updatedAt,
    );
    const approval = resolutionClaim.approval;
    if (!approval) {
      return NextResponse.json({ ok: false, error: 'Approval not found' }, { status: 404 });
    }
    if (!resolutionClaim.claimed) {
      const continuationPending = approval.resolution?.continuationStatus === 'pending'
        || approval.resolution?.continuationStatus === 'outcome_unknown';
      const status = approval.status === 'pending' || continuationPending ? 409 : 200;
      return NextResponse.json({
        ok: approval.status !== 'pending' && !continuationPending,
        approval,
        resolved: action,
        note: continuationPending
          ? 'The approval decision was recorded, but its continuation is not confirmed. Inspect the target before retrying.'
          : approval.status === 'pending'
          ? 'Approval changed while it was being resolved. Review it again.'
          : 'Approval was already resolved.',
      }, {
        status,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    // If resolveApproval returned a record that is already resolved (status !== pending
    // before our call), skip the file edit — it was already applied by the winner.
    let appliedEdit: { filePath: string; message: string } | undefined;
    if (action === 'approve' && current.toolName === 'edit_file' && approval.status === 'approved' && approval.resolvedAt === approval.updatedAt) {
      const applyResult = await applyApprovedFileEdit(current);
      if (!applyResult.ok) {
        const uncertain = applyResult.code === 'write_failed';
        const failedApproval = uncertain && resolutionClaim.claimId
          ? finalizeApprovalContinuation(id, resolutionClaim.claimId, 'outcome_unknown', applyResult.error)
          : resolutionClaim.claimId
            ? reopenApprovalAfterEvidenceDrift(id, resolutionClaim.claimId, applyResult.error)
            : approval;
        invalidateApprovalCaches();
        return NextResponse.json({
          ok: false,
          error: applyResult.error,
          code: applyResult.code,
          approval: failedApproval,
          outcomeUnknown: uncertain || undefined,
        }, {
          status: uncertain ? 409 : applyResult.status,
          headers: { 'Cache-Control': 'no-store, max-age=0' },
        });
      }

      appliedEdit = {
        filePath: applyResult.filePath,
        message: applyResult.message,
      };
    }

    // Spec-update continuation — apply via writePacketSpec on approve.
    // resolveApproval already settled atomically; only the winner of the race
    // (resolvedAt === updatedAt) writes to disk, so concurrent approvers
    // can't corrupt the spec file.
    let appliedSpecUpdate: { packetId: string; message: string; updatedAt?: string } | undefined;
    if (
      action === 'approve'
      && approval.continuation?.kind === 'spec-update'
      && approval.status === 'approved'
      && approval.resolvedAt === approval.updatedAt
    ) {
      const applyResult = await applyApprovedSpecUpdate(approval);
      if (!applyResult.ok) {
        const failedApproval = resolutionClaim.claimId
          ? finalizeApprovalContinuation(id, resolutionClaim.claimId, 'outcome_unknown', applyResult.message)
          : approval;
        invalidateApprovalCaches();
        return NextResponse.json({
          ok: false,
          error: applyResult.message,
          code: applyResult.error,
          approval: failedApproval,
          outcomeUnknown: true,
        }, {
          status: 409,
          headers: { 'Cache-Control': 'no-store, max-age=0' },
        });
      }
      appliedSpecUpdate = {
        packetId: applyResult.packetId,
        message: applyResult.message,
        updatedAt: applyResult.updatedAt,
      };
    }

    // Route resolution based on continuation type
    let decisionNote = appliedSpecUpdate?.message
      ?? appliedEdit?.message
      ?? (action === 'approve' ? 'Approved.' : 'Denied.');
    let assistantMessage: unknown = undefined;
    let nextApproval: unknown = undefined;
    let continuationOutcome: 'completed' | 'failed' | 'outcome_unknown' = 'completed';

    const continuation = approval.continuation;

    if (continuation?.kind === 'llm-chat') {
      // LLM chat continuation
      const decision = action === 'approve'
        ? await resumeLlmApproval(request.url, approval, { actor: 'desktop', editedCommand })
        : rejectLlmApproval(approval, 'desktop');
      decisionNote = mergeDecisionNotes(appliedEdit?.message, decision.note);
      assistantMessage = decision.assistantMessage;
      nextApproval = decision.nextApproval;
    } else if (continuation?.kind === 'lane' && action === 'approve') {
      // Lane continuation — re-dispatch the lane command
      // Accept optional merge strategy from the operator's approval action
      const strategy = requestedStrategy ?? continuation.strategy;
      const { dispatch } = await import('@/lib/lane/commands');
      const result = await dispatch({
        verb: continuation.verb,
        laneId: continuation.laneId,
        commitMessage: continuation.commitMessage,
        expectedHeadSha: spokenReviewEvidence?.reviewedHeadSha ?? continuation.expectedHeadSha,
        expectedDiffFingerprint: spokenReviewEvidence?.reviewedDiffFingerprint,
        expectedGovernanceFingerprint: spokenReviewEvidence?.reviewedGovernanceFingerprint,
        spokenReviewApprovalId: spokenReviewEvidence?.approvalId,
        spokenReviewClaimId: spokenReviewEvidence ? resolutionClaim.claimId : undefined,
        spokenReviewUpdatedAt: spokenReviewEvidence ? current.updatedAt : undefined,
        spokenReviewLaneStatus: spokenReviewEvidence ? reviewedLaneStatus : undefined,
        strategy,
        actor: 'user',
      } as Parameters<typeof dispatch>[0]);
      const spokenReviewDrift = result.reason === 'diff_changed_since_spoken_review'
        || result.reason === 'governance_changed_since_spoken_review'
        || result.reason === 'head_moved_since_review'
        || (Boolean(spokenReviewEvidence) && Boolean(result.expectedHeadSha));
      if (spokenReviewDrift) {
        const reopened = reopenApprovalAfterEvidenceDrift(
          approval.id,
          resolutionClaim.claimId!,
          result.note,
        );
        invalidateApprovalCaches();
        await publishRealtimeMutation({
          mutation: {
            mutationId: `approval-review-stale-${approval.id}`,
            source: 'desktop',
            action: 'approve',
            sessionKey: approval.sessionKey,
            surfaceId: approval.sessionKey,
            status: 'pending',
            note: result.note,
            createdAt: new Date().toISOString(),
          },
          refreshTargets: ['global', 'mobileInbox', 'sessionHistory'],
          sessionKeys: [approval.sessionKey],
          fresh: true,
        });
        return NextResponse.json({
          ok: false,
          error: result.note,
          code: 'spoken_review_changed',
          approval: reopened,
        }, {
          status: 409,
          headers: { 'Cache-Control': 'no-store, max-age=0' },
        });
      }
      if (!result.ok) continuationOutcome = 'failed';
      decisionNote = mergeDecisionNotes(appliedEdit?.message, result.note);
    } else if (continuation?.kind === 'plan' && action === 'approve') {
      // Plan continuation — create mission from approved plan
      try {
        const { dispatchApprovedPlan } = await import('@/lib/intake/plan-dispatch');
        const result = await dispatchApprovedPlan(continuation);
        decisionNote = mergeDecisionNotes(appliedEdit?.message, result.note);
      } catch (error) {
        continuationOutcome = 'outcome_unknown';
        decisionNote = `Plan dispatch failed: ${error instanceof Error ? error.message : 'unknown'}`;
      }
    } else if (continuation?.kind === 'runtime' && action === 'approve') {
      // Runtime continuation — launch or resume the session
      if (continuation.action === 'launch' && continuation.prompt) {
        const cwd = continuation.cwd || process.cwd();
        const result = await launchRuntimeSurface({
          runtime: continuation.runtimeId as RuntimeId,
          cwd,
          repoPath: cwd,
          prompt: continuation.prompt,
          skipSetup: true,
        });
        if (!result.ok) continuationOutcome = 'failed';
        decisionNote = mergeDecisionNotes(appliedEdit?.message, result.note);
      } else if (continuation.action === 'resume' && continuation.message) {
        const rt = getRuntime(continuation.runtimeId);
        if (rt) {
          const result = await rt.resume(continuation.sessionKey, continuation.message);
          if (!result.ok) continuationOutcome = 'failed';
          decisionNote = mergeDecisionNotes(appliedEdit?.message, result.note);
        } else {
          continuationOutcome = 'failed';
          decisionNote = mergeDecisionNotes(
            appliedEdit?.message,
            `Runtime ${continuation.runtimeId} is unavailable.`,
          );
        }
      }
    }

    const settledApproval = approval.resolution?.continuationStatus && resolutionClaim.claimId
      ? finalizeApprovalContinuation(approval.id, resolutionClaim.claimId, continuationOutcome, decisionNote)
      : approval;

    invalidateApprovalCaches();
    await publishRealtimeMutation({
      mutation: {
        mutationId: `approval-${action}-${approval.id}`,
        source: 'desktop',
        action,
        sessionKey: approval.sessionKey,
        surfaceId: approval.sessionKey,
        status: continuationOutcome === 'completed' ? 'completed' : 'failed',
        note: decisionNote,
        createdAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      },
      refreshTargets: ['global', 'mobileInbox', 'sessionHistory'],
      sessionKeys: [approval.sessionKey],
      fresh: continuationOutcome === 'completed',
    });

    return NextResponse.json({
      ok: true,
      approval: settledApproval,
      resolved: action,
      note: decisionNote,
      assistantMessage,
      nextApproval,
      appliedEdit,
      appliedSpecUpdate,
    }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to resolve approval',
    }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }
}
