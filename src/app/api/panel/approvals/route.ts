import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { applyApprovedFileEdit } from '@/lib/approvals/file-edit';
import { applyApprovedSpecUpdate } from '@/lib/approvals/spec-update';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { rejectLlmApproval, resumeLlmApproval } from '@/lib/approvals/llm';
import {
  createApproval,
  createTestApproval,
  getApproval,
  listApprovals,
  listApprovalsForContext,
  resolveApproval,
} from '@/lib/approvals/store';
import type { CreateApprovalInput } from '@/lib/approvals/types';
import { launchRuntimeSurface } from '@/lib/runtime/actions';
import type { RuntimeId } from '@/lib/runtimes';
import { getRuntime } from '@/lib/runtimes/registry';
import { invalidateInboxCache } from '@/lib/mobile/inbox';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';

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
 * GET /api/panel/approvals — list pending approvals from the shared queue.
 */
export async function GET(request: NextRequest) {
  const sessionKey = request.nextUrl.searchParams.get('sessionKey')?.trim() || undefined;
  const packetId = request.nextUrl.searchParams.get('packetId')?.trim() || undefined;
  const laneId = request.nextUrl.searchParams.get('laneId')?.trim() || undefined;
  const statusParam = request.nextUrl.searchParams.get('status')?.trim() || 'pending';
  const status = statusParam === 'all' ? 'all' : 'pending';
  const approvals = (packetId || laneId)
    ? listApprovalsForContext({ packetId, laneId, sessionKey })
      .filter((approval) => status === 'all' || approval.status === status)
    : listApprovals({ status, sessionKey });

  return NextResponse.json({ approvals }, {
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
    // resolveApproval is atomic in SQLite and guards against double-resolve.
    // Call it first so a concurrent request loses the race and short-circuits
    // before any file mutation occurs (close TOCTOU window).
    const approval = resolveApproval(id, action, 'desktop');
    if (!approval) {
      return NextResponse.json({ ok: false, error: 'Approval not found' }, { status: 404 });
    }

    // If resolveApproval returned a record that is already resolved (status !== pending
    // before our call), skip the file edit — it was already applied by the winner.
    let appliedEdit: { filePath: string; message: string } | undefined;
    if (action === 'approve' && current.toolName === 'edit_file' && approval.status === 'approved' && approval.resolvedAt === approval.updatedAt) {
      const applyResult = await applyApprovedFileEdit(current);
      if (!applyResult.ok) {
        return NextResponse.json({
          ok: false,
          error: applyResult.error,
          code: applyResult.code,
          approval,
        }, {
          status: applyResult.status,
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
        return NextResponse.json({
          ok: false,
          error: applyResult.message,
          code: applyResult.error,
          approval,
        }, {
          status: 500,
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
      const strategy = typeof body.strategy === 'string'
        && (body.strategy === 'ours' || body.strategy === 'theirs' || body.strategy === 'manual')
        ? body.strategy
        : continuation.strategy;
      const { dispatch } = await import('@/lib/lane/commands');
      const result = await dispatch({
        verb: continuation.verb,
        laneId: continuation.laneId,
        commitMessage: continuation.commitMessage,
        expectedHeadSha: continuation.expectedHeadSha,
        strategy,
        actor: 'user',
      } as Parameters<typeof dispatch>[0]);
      decisionNote = mergeDecisionNotes(appliedEdit?.message, result.note);
    } else if (continuation?.kind === 'plan' && action === 'approve') {
      // Plan continuation — create mission from approved plan
      try {
        const { dispatchApprovedPlan } = await import('@/lib/intake/plan-dispatch');
        const result = await dispatchApprovedPlan(continuation);
        decisionNote = mergeDecisionNotes(appliedEdit?.message, result.note);
      } catch (error) {
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
        decisionNote = mergeDecisionNotes(appliedEdit?.message, result.note);
      } else if (continuation.action === 'resume' && continuation.message) {
        const rt = getRuntime(continuation.runtimeId);
        if (rt) {
          const result = await rt.resume(continuation.sessionKey, continuation.message);
          decisionNote = mergeDecisionNotes(appliedEdit?.message, result.note);
        }
      }
    }

    invalidateApprovalCaches();
    await publishRealtimeMutation({
      mutation: {
        mutationId: `approval-${action}-${approval.id}`,
        source: 'desktop',
        action,
        sessionKey: approval.sessionKey,
        surfaceId: approval.sessionKey,
        status: 'completed',
        note: decisionNote,
        createdAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      },
      refreshTargets: ['global', 'mobileInbox', 'sessionHistory'],
      sessionKeys: [approval.sessionKey],
      fresh: true,
    });

    return NextResponse.json({
      ok: true,
      approval,
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
