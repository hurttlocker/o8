export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '@/app/api/orchestrator/_utils';
import { listTaskArtifactActionReceipts, submitTaskArtifactAction, TaskArtifactError } from '@/lib/task-artifacts/service';
import { TASK_ARTIFACT_ID_PATTERN } from '@/lib/task-artifacts/types';

/**
 * POST /api/task-artifacts/[id]/actions — the return channel.
 *   { action, payload, nonce, target }
 * Operator or device only: a dispatched worker cannot submit on the operator's
 * behalf. The server revalidates identity, liveness, the declared schema,
 * replay, and rate, records a receipt either way, and delivers packet targets
 * itself. Thread targets return `deliverVia: 'thread'` and the host rides the
 * operator's own turn, stamped so the realtime server marks it delivered.
 *
 * GET /api/task-artifacts/[id]/actions — the receipt ledger for one artifact.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!TASK_ARTIFACT_ID_PATTERN.test(id)) return operatorError('invalid_request', 'Invalid task artifact id.', 400);
  const ctx = resolveRequestPrincipalContext(request);
  if (ctx.role === 'worker') {
    return operatorError('forbidden', 'Task artifact actions are operator-only; a dispatched worker cannot submit them.', 403);
  }
  if (ctx.role !== 'operator' && ctx.role !== 'device') {
    return operatorError('unauthorized', 'Submitting a task artifact action requires the operator credential or an enrolled device.', 401);
  }
  const body = asRecord(await parseJsonBody(request));
  if (!body) return operatorError('invalid_request', 'Invalid JSON body.', 400);
  try {
    const result = await submitTaskArtifactAction(id, {
      action: body.action,
      payload: body.payload,
      nonce: body.nonce,
      target: body.target,
      actor: ctx.role,
    });
    if (result.accepted) return operatorSuccess(result);
    return NextResponse.json({ ok: false, error: { code: result.code, message: result.reason }, result }, { status: 422 });
  } catch (error) {
    if (error instanceof TaskArtifactError) return operatorError(error.code, error.message, error.status, error.details);
    return operatorError('submit_failed', error instanceof Error ? error.message : String(error), 500);
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!TASK_ARTIFACT_ID_PATTERN.test(id)) return operatorError('invalid_request', 'Invalid task artifact id.', 400);
  const ctx = resolveRequestPrincipalContext(request);
  if (ctx.role !== 'operator' && ctx.role !== 'device') {
    return operatorError('unauthorized', 'Reading task artifact receipts requires the operator credential.', 401);
  }
  return operatorSuccess({ actions: listTaskArtifactActionReceipts(id) });
}
