import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { loadMergeModule } from '@/lib/orchestrator/operator-mission-service/merge-warmup';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  try {
    const { approveAndMergePacket } = await loadMergeModule();
    const result = await approveAndMergePacket({
      packetId,
      commitMessage: typeof record.commitMessage === 'string' && record.commitMessage.trim()
        ? record.commitMessage.trim()
        : undefined,
      expectedHeadSha: typeof record.expectedHeadSha === 'string' && record.expectedHeadSha.trim()
        ? record.expectedHeadSha.trim()
        : undefined,
    });
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
