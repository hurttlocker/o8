import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { pickComparisonWinner } from '@/lib/orchestrator/operator-mission-service';
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
    const result = await pickComparisonWinner({
      packetId,
      commitMessage: typeof record.commitMessage === 'string' && record.commitMessage.trim()
        ? record.commitMessage.trim()
        : undefined,
    });
    return operatorSuccess(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to pick a comparison winner.';
    return operatorError('comparison_pick_failed', message, 500, error);
  }
}
