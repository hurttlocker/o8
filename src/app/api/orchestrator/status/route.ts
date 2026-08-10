import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getMissionStatus, MissionNotFoundError } from '@/lib/orchestrator/operator-mission-service';
import { operatorError, operatorSuccess } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const missionId = request.nextUrl.searchParams.get('missionId')?.trim() || undefined;
  const includeCost = request.nextUrl.searchParams.get('includeCost') === 'true';

  try {
    const result = await getMissionStatus({
      missionId,
      includeCost,
    });
    return operatorSuccess(result);
  } catch (error) {
    if (error instanceof MissionNotFoundError) {
      return operatorError('not_found', error.message, 404);
    }
    const message = error instanceof Error ? error.message : 'Unable to read mission status.';
    return operatorError('status_failed', message, 500, error);
  }
}
