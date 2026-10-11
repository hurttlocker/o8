import { NextRequest } from 'next/server';

import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { requirePanelAuth } from '@/lib/panel/auth';
import { WORKTREE_MAINTENANCE_POLICY } from '@/lib/worktree/maintenance-budget';
import { readWorktreeMaintenanceStatus } from '@/lib/worktree/maintenance-discovery';
import { operatorError, operatorSuccess } from '../../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (resolveRequestPrincipal(request) !== 'operator') {
    return operatorError('forbidden', 'Worktree maintenance inventory is operator-only.', 403);
  }
  try {
    const after = request.nextUrl.searchParams.get('after') ?? '';
    if (after.length > 4_096) return operatorError('invalid_request', 'Invalid maintenance cursor.', 400);
    return operatorSuccess({ ...readWorktreeMaintenanceStatus(after), policy: WORKTREE_MAINTENANCE_POLICY });
  } catch {
    return operatorError('maintenance_unavailable', 'Worktree maintenance inventory is unavailable.', 503);
  }
}
