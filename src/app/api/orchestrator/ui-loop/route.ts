import { NextRequest } from 'next/server';
import { findWarmUiLoopPacket } from '@/lib/orchestrator/ui-loop';
import { operatorError, operatorSuccess } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const repoPath = request.nextUrl.searchParams.get('repo')?.trim() ?? '';
  if (!repoPath) {
    return operatorError('invalid_request', 'repo query parameter is required.', 400);
  }

  try {
    return operatorSuccess(findWarmUiLoopPacket(repoPath));
  } catch (error) {
    return operatorError(
      'ui_loop_lookup_failed',
      error instanceof Error ? error.message : 'Unable to resolve a warm Design Mode packet.',
      500,
      error,
    );
  }
}
