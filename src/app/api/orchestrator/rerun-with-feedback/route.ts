import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { rerunWithFeedback } from '@/lib/orchestrator/operator-mission-service';
import {
  RerunCleanupFailedError,
  RerunKillUnconfirmedError,
  RerunPostRetirementFailedError,
  RerunSessionArchiveUnconfirmedError,
  RerunStateChangedError,
} from '@/lib/orchestrator/operator-mission-service/rerun-with-feedback';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { asRecord, operatorError, operatorSuccess, parseJsonBody, replayShape, unresolvedIdempotencyResponse } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FEEDBACK_LENGTH = 4000;

interface RerunFailureReceipt {
  ok: false;
  code: string;
  message: string;
  status: number;
}

type RerunReceipt =
  | { ok: true; result: Awaited<ReturnType<typeof rerunWithFeedback>> }
  | RerunFailureReceipt;

function rerunFailureReceipt(error: unknown): RerunFailureReceipt {
  const message = error instanceof Error ? error.message : 'Unable to rerun packet with feedback.';
  if (error instanceof RerunKillUnconfirmedError) return { ok: false, code: 'kill_unconfirmed', message, status: 409 };
  if (error instanceof RerunSessionArchiveUnconfirmedError) {
    return { ok: false, code: 'session_archive_unconfirmed', message, status: 409 };
  }
  if (error instanceof RerunCleanupFailedError) {
    return { ok: false, code: 'worktree_cleanup_failed', message, status: 409 };
  }
  if (error instanceof RerunPostRetirementFailedError) return { ok: false, code: 'rerun_failed', message, status: 409 };
  if (error instanceof RerunStateChangedError) return { ok: false, code: 'packet_state_changed', message, status: 409 };
  return { ok: false, code: 'rerun_failed', message, status: 500 };
}

function rerunFailureResponse(receipt: RerunFailureReceipt, replayed: boolean) {
  const response = operatorError(receipt.code, receipt.message, receipt.status);
  if (replayed) response.headers.set('x-o8-idempotency-replayed', '1');
  return response;
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  // Operator/orchestrator-only control verb — a dispatched worker cannot rerun
  // any packet (§HIGH-4).
  if (resolveRequestPrincipal(request) !== 'operator') {
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

  // #1497 — persisted idempotency. THE live incident: a rerun timed out
  // client-side (15s × 3) but landed server-side TWICE, forking two parallel
  // clones. A dispatch takes minutes, so the retry arrives while the original
  // is still running — the reserve→finalize protocol returns "in progress, not
  // re-executed" instead of dispatching a second worker.
  const clientKey = typeof record.idempotencyKey === 'string' && record.idempotencyKey.trim()
    ? record.idempotencyKey.trim()
    : null;
  if (!clientKey) {
    return operatorError(
      'idempotency_key_required',
      'idempotencyKey is required to rerun a packet with feedback.',
      400,
    );
  }
  const canonicalBody = JSON.stringify({ packetId, feedback });
  const key = deriveIdempotencyKey({ verb: 'rerun_with_feedback', scopeId: packetId, clientKey, body: canonicalBody });

  try {
    const binding = bindIdempotencyClientMutation({
      namespace: 'rerun_with_feedback',
      clientKey,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return operatorError(
        'idempotency_key_conflict',
        'idempotencyKey was already used for a different packet rerun.',
        409,
      );
    }
    if (binding.status === 'unavailable') {
      return operatorError(
        'idempotency_store_unavailable',
        'The persisted idempotency store is unavailable; the packet was not rerun.',
        503,
      );
    }
    const outcome = await withIdempotency<RerunReceipt>(
      { key, verb: 'rerun_with_feedback', scopeId: packetId },
      async () => {
        try {
          return { ok: true, result: await rerunWithFeedback({ packetId, feedback }) };
        } catch (error) {
          // Lifecycle failures can happen after the old worker was stopped or
          // its worktree was retired. Persist the terminal truth so an exact
          // transport retry cannot repeat those destructive steps.
          return rerunFailureReceipt(error);
        }
      },
    );
    if (outcome.inProgress) return unresolvedIdempotencyResponse(outcome, 'packet rerun') ?? operatorSuccess(replayShape(outcome), 202);
    if (!outcome.result.ok) return rerunFailureResponse(outcome.result, outcome.replayed);
    return operatorSuccess(replayShape({ ...outcome, result: outcome.result.result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to rerun packet with feedback.';
    return operatorError('rerun_failed', message, 500, error);
  }
}
