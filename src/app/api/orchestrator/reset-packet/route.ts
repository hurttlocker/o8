import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resetPacket } from '@/lib/orchestrator/operator-mission-service';
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
    const result = await resetPacket({
      packetId,
      reason: typeof record.reason === 'string' ? record.reason.trim() : undefined,
      clearWorktree: record.clearWorktree === true,
    });
    return operatorSuccess(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to reset packet.';
    return operatorError('reset_failed', message, 500, error);
  }
}
