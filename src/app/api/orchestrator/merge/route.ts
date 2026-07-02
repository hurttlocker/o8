import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { loadMergeModule } from '@/lib/orchestrator/operator-mission-service/merge-warmup';
import { getIdempotent, setIdempotent } from '@/lib/orchestrator/idempotency-cache';
import { withSynchronousWorktreeCleanup } from '@/lib/orchestrator/worktree-cleanup';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// #2 Stage 5 — idempotency + synchronous worktree-cleanup live HERE now (was in
// the MCP approve_and_merge handler, MCP-process-local). Server-side means every
// client — MCP, the `o8 packet approve-merge` CLI, future mobile — inherits the
// same dedupe + clean-tree-on-return guarantee through this one route.
function buildIdempotencyKey(packetId: string, clientKey: string): string {
  return `approve_and_merge:${packetId}:${clientKey}`;
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const packetId = typeof record.packetId === 'string' ? record.packetId.trim() : '';
  if (!packetId) {
    return operatorError('invalid_request', 'packetId is required.', 400);
  }

  // #2 Stage 5b — worker-context governance. When the caller is a dispatched
  // worker we do NOT merge: raise an operator approval card and return a clean
  // pending status. The operator clears it (o8 inbox approve), which dispatches
  // the lane-merge continuation through the full gate. A human operator call
  // falls through and merges directly.
  //
  // Worker context is derived from the request PRINCIPAL (the local-worker token
  // its CLI presents), not just the self-asserted `requestedByWorker` body flag —
  // otherwise a worker could omit the flag and take the direct-merge path
  // (SECURITY_AUDIT_2026-07-02 §HIGH-4). The body flag is retained as an
  // additional signal for older CLIs.
  const isWorkerContext = record.requestedByWorker === true
    || resolveRequestPrincipal(request) === 'worker';
  if (isWorkerContext) {
    const { findLaneByPacket } = await import('@/lib/lane/registry');
    const lane = findLaneByPacket(packetId);
    if (!lane) {
      return operatorError('lane_not_found', `No lane found for packet ${packetId}.`, 404);
    }
    try {
      const { raiseWorkerMergeApproval } = await import('@/lib/lane/commands');
      const result = await raiseWorkerMergeApproval(lane, {
        commitMessage: typeof record.commitMessage === 'string' ? record.commitMessage.trim() || undefined : undefined,
        expectedHeadSha: typeof record.expectedHeadSha === 'string' ? record.expectedHeadSha.trim() || undefined : undefined,
      });
      return operatorSuccess({
        merged: false,
        status: 'pending_operator_approval',
        approvalId: result.approvalId ?? null,
        laneId: result.laneId,
        note: result.note,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to raise merge approval.';
      return operatorError('approval_failed', message, 500, error);
    }
  }

  const clientKey = typeof record.idempotencyKey === 'string' && record.idempotencyKey.trim()
    ? record.idempotencyKey.trim()
    : null;
  const cacheKey = clientKey ? buildIdempotencyKey(packetId, clientKey) : null;
  if (cacheKey) {
    const cached = getIdempotent<Record<string, unknown>>(cacheKey);
    if (cached) {
      return operatorSuccess({ ...cached, idempotencyReplay: true });
    }
  }

  try {
    const { approveAndMergePacket } = await loadMergeModule();
    // #622 — guarantee a clean working tree before control returns to any client.
    const result = await withSynchronousWorktreeCleanup(packetId, () => approveAndMergePacket({
      packetId,
      commitMessage: typeof record.commitMessage === 'string' && record.commitMessage.trim()
        ? record.commitMessage.trim()
        : undefined,
      expectedHeadSha: typeof record.expectedHeadSha === 'string' && record.expectedHeadSha.trim()
        ? record.expectedHeadSha.trim()
        : undefined,
    }));
    if (cacheKey) {
      setIdempotent(cacheKey, result as unknown as Record<string, unknown>);
    }
    return operatorSuccess(result);
  } catch (error) {
    const { isHeadShaMismatchError } = await loadMergeModule();
    if (isHeadShaMismatchError(error)) {
      return NextResponse.json({
        ok: false,
        error: {
          code: 'head_sha_mismatch',
          message: error.message,
        },
        currentHeadSha: error.currentHeadSha,
        expectedHeadSha: error.expectedHeadSha,
      }, {
        status: 409,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }
    const message = error instanceof Error ? error.message : 'Unable to approve and merge packet.';
    return operatorError('merge_failed', message, 500, error);
  }
}
