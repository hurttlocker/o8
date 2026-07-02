import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { rerunWithFeedback } from '@/lib/orchestrator/operator-mission-service';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FEEDBACK_LENGTH = 4000;

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  // Operator/orchestrator-only control verb — a dispatched worker cannot rerun
  // any packet (§HIGH-4).
  if (resolveRequestPrincipal(request) === 'worker') {
    return operatorError('forbidden', 'Rerunning packets is operator-only; a dispatched worker cannot call this.', 403);
  }

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const packetId = typeof record.packetId === 'string' ? record.packetId.trim() : '';
  if (!packetId) {
    return operatorError('invalid_request', 'packetId is required.', 400);
  }

  const feedbackRaw = typeof record.feedback === 'string' ? record.feedback : '';
  const feedback = feedbackRaw.trim();
  if (!feedback) {
    return operatorError('invalid_request', 'feedback is required.', 400);
  }
  if (feedback.length > MAX_FEEDBACK_LENGTH) {
    return operatorError(
      'invalid_request',
      `feedback exceeds maximum length of ${MAX_FEEDBACK_LENGTH} characters.`,
      400,
    );
  }

  try {
    const result = await rerunWithFeedback({ packetId, feedback });
    return operatorSuccess(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to rerun packet with feedback.';
    return operatorError('rerun_failed', message, 500, error);
  }
}
