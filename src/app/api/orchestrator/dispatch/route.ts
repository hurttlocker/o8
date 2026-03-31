import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { dispatchMission } from '@/lib/orchestrator/operator-mission-service';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  if (body === null) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const record = asRecord(body) ?? {};

  try {
    const result = await dispatchMission({
      missionId: typeof record.missionId === 'string' && record.missionId.trim()
        ? record.missionId.trim()
        : undefined,
    });
    return operatorSuccess(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to dispatch mission.';
    return operatorError('dispatch_failed', message, 500, error);
  }
}
