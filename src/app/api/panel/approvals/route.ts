import { NextRequest, NextResponse } from 'next/server';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { rejectLlmApproval, resumeLlmApproval } from '@/lib/approvals/llm';
import {
  createApproval,
  createTestApproval,
  getApproval,
  listApprovals,
  resolveApproval,
} from '@/lib/approvals/store';
import type { CreateApprovalInput } from '@/lib/approvals/types';
import { getRuntime } from '@/lib/runtimes/registry';
import { invalidateInboxCache } from '@/lib/mobile/inbox';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function invalidateApprovalCaches() {
  invalidateCommandCenterSnapshotCaches();
  invalidateInboxCache();
}

/**
 * GET /api/panel/approvals — list pending approvals from the shared queue.
 */
export async function GET(request: NextRequest) {
  const sessionKey = request.nextUrl.searchParams.get('sessionKey')?.trim() || undefined;
  const statusParam = request.nextUrl.searchParams.get('status')?.trim() || 'pending';
  const status = statusParam === 'all' ? 'all' : 'pending';
  const approvals = listApprovals({ status, sessionKey });

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

    const approval = createApproval({
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
  const approval = resolveApproval(id, action, 'desktop');
  if (!approval) {
    return NextResponse.json({ ok: false, error: 'Approval not found' }, { status: 404 });
  }
  // Route resolution based on continuation type
  let decisionNote = action === 'approve' ? 'Approved.' : 'Denied.';
  let assistantMessage: unknown = undefined;
  let nextApproval: unknown = undefined;

  const continuation = approval.continuation;

  try {
    if (continuation?.kind === 'llm-chat') {
      // LLM chat continuation
      const decision = action === 'approve'
        ? await resumeLlmApproval(request.url, approval, { actor: 'desktop', editedCommand })
        : rejectLlmApproval(approval, 'desktop');
      decisionNote = decision.note;
      assistantMessage = decision.assistantMessage;
      nextApproval = decision.nextApproval;
    } else if (continuation?.kind === 'lane' && action === 'approve') {
      // Lane continuation — re-dispatch the lane command
      const { dispatch } = await import('@/lib/lane/commands');
      const result = await dispatch({
        verb: continuation.verb,
        laneId: continuation.laneId,
        commitMessage: continuation.commitMessage,
        actor: 'user',
      } as Parameters<typeof dispatch>[0]);
      decisionNote = result.note;
    } else if (continuation?.kind === 'runtime' && action === 'approve') {
      // Runtime continuation — launch or resume the session
      if (continuation.action === 'launch' && continuation.prompt) {
        const rt = getRuntime(continuation.runtimeId);
        if (rt) {
          const result = await rt.launch({ cwd: continuation.cwd || process.cwd(), prompt: continuation.prompt });
          decisionNote = result.note;
        }
      } else if (continuation.action === 'resume' && continuation.message) {
        const rt = getRuntime(continuation.runtimeId);
        if (rt) {
          const result = await rt.resume(continuation.sessionKey, continuation.message);
          decisionNote = result.note;
        }
      }
    }
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to resolve approval',
    }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
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
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
