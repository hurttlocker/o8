import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
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
