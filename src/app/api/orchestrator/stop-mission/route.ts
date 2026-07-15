import { NextRequest } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { stopMission } from '@/lib/orchestrator/mission-stop';
import { requirePanelAuth } from '@/lib/panel/auth';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  if (resolveRequestPrincipal(request) !== 'operator') {
    return operatorError('forbidden', 'Stopping missions is operator-only; a dispatched worker cannot call this.', 403);
  }

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const missionId = typeof record.missionId === 'string' ? record.missionId.trim() : '';
  if (!missionId) {
    return operatorError('invalid_request', 'missionId is required.', 400);
  }

  try {
    const result = await stopMission(missionId);
    return operatorSuccess(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to stop mission.';
    return operatorError('stop_mission_failed', message, 500, error);
  }
}
