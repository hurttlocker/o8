import { NextRequest } from 'next/server';

import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { readLatestClaimUnbacked } from '@/lib/lane/report-claim-check';
import { requirePanelAuth } from '@/lib/panel/auth';
import { operatorError, operatorSuccess } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Latest advisory `claim_unbacked` event for a lane (#2447). Operator-only, read-only. */
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (resolveRequestPrincipal(request) !== 'operator') {
    return operatorError('forbidden', 'Report claim checks are operator-only.', 403);
  }
  const laneId = request.nextUrl.searchParams.get('laneId')?.trim() ?? '';
  if (!laneId) return operatorError('invalid_request', 'laneId is required.', 400);
  try {
    return operatorSuccess({ laneId, claim: readLatestClaimUnbacked(laneId) });
  } catch (error) {
    console.warn('[report-claim-check] read failed:', error instanceof Error ? error.message : 'error');
    return operatorError('read_failed', 'Unable to read the report claim check.', 500);
  }
}
