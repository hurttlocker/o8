import { sanitizeErrorMessage } from '@/lib/api/error-format';
import type { LaneApprovalContinuation } from '@/lib/approvals/types';
import { isDiscoveredCliSessionKey } from '@/lib/runtime/discovered-cli-session';

export function requiresDesktopLaneChoice(runtime: string, sessionKey: string, continuation: LaneApprovalContinuation): boolean {
  return continuation.verb === 'resume' && isDiscoveredCliSessionKey(runtime, sessionKey);
}

export async function dispatchMobileLaneContinuation(continuation: LaneApprovalContinuation): Promise<{
  outcome: 'completed' | 'failed' | 'outcome_unknown';
  note: string;
}> {
  try {
    const { dispatch } = await import('@/lib/lane/commands');
    const result = await dispatch({
      verb: continuation.verb,
      laneId: continuation.laneId,
      commitMessage: continuation.commitMessage,
      expectedHeadSha: continuation.expectedHeadSha,
      strategy: continuation.strategy,
      actor: 'user',
    } as Parameters<typeof dispatch>[0]);
    return { outcome: result.ok ? 'completed' : 'failed', note: result.note };
  } catch (error) {
    return {
      outcome: 'outcome_unknown',
      note: `Lane ${continuation.verb} failed: ${sanitizeErrorMessage(error, 'unknown')}`,
    };
  }
}
