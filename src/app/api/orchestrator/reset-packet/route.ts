import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { resetPacket } from '@/lib/orchestrator/operator-mission-service';
import {
  ResetCleanupFailedError,
  ResetKillUnconfirmedError,
  ResetSessionArchiveUnconfirmedError,
} from '@/lib/orchestrator/operator-mission-service/reset';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { asRecord, operatorError, operatorSuccess, parseJsonBody, replayShape, unresolvedIdempotencyResponse } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ResetResult = Awaited<ReturnType<typeof resetPacket>>;

interface ResetFailureReceipt {
  ok: false;
  code: string;
  message: string;
  status: number;
  result?: ResetCleanupFailedError['result'];
}

type ResetReceipt =
  | { ok: true; result: ResetResult }
  | ResetFailureReceipt;

function resetFailureReceipt(error: unknown): ResetFailureReceipt {
  const message = error instanceof Error ? error.message : 'Unable to reset packet.';
  if (error instanceof ResetKillUnconfirmedError) return { ok: false, code: 'kill_unconfirmed', message, status: 409 };
  if (error instanceof ResetSessionArchiveUnconfirmedError) {
    return { ok: false, code: 'session_archive_unconfirmed', message, status: 409 };
  }
  if (error instanceof ResetCleanupFailedError) {
    return { ok: false, code: 'worktree_cleanup_failed', message, status: 409, result: error.result };
  }
  return { ok: false, code: 'reset_failed', message, status: 500 };
}

function resetFailureResponse(receipt: ResetFailureReceipt, replayed: boolean) {
  const response = receipt.result
    ? Response.json({
        ok: false,
        error: { code: receipt.code, message: receipt.message },
        result: receipt.result,
      }, {
        status: receipt.status,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      })
    : operatorError(receipt.code, receipt.message, receipt.status);
  if (replayed) response.headers.set('x-o8-idempotency-replayed', '1');
  return response;
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  // Operator/orchestrator-only control verb — a dispatched worker cannot reset
  // any packet (§HIGH-4).
  if (resolveRequestPrincipal(request) !== 'operator') {
    return operatorError('forbidden', 'Resetting packets is operator-only; a dispatched worker cannot call this.', 403);
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

  // #1497 — persisted idempotency (reset_packet + retry_packet share this route).
  // clearWorktree distinguishes the two verbs, so it's part of the derived key:
  // a reset and a retry on the same packet must NOT collide.
  const clearWorktree = record.clearWorktree === true;
  const reason = typeof record.reason === 'string' ? record.reason.trim() : undefined;
  const clientKey = typeof record.idempotencyKey === 'string' && record.idempotencyKey.trim()
    ? record.idempotencyKey.trim()
    : null;
  if (!clientKey) {
    return operatorError(
      'idempotency_key_required',
      'idempotencyKey is required for packet reset and retry actions.',
      400,
    );
  }
  const canonicalBody = JSON.stringify({ packetId, clearWorktree, reason });
  const key = deriveIdempotencyKey({
    verb: 'reset_packet',
    scopeId: packetId,
    clientKey,
    body: canonicalBody,
  });

  try {
    const binding = bindIdempotencyClientMutation({
      namespace: 'reset_packet',
      clientKey,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return operatorError(
        'idempotency_key_conflict',
        'idempotencyKey was already used for a different packet reset or retry.',
        409,
      );
    }
    if (binding.status === 'unavailable') {
      return operatorError(
        'idempotency_store_unavailable',
        'The persisted idempotency store is unavailable; the packet was not reset.',
        503,
      );
    }
    const outcome = await withIdempotency<ResetReceipt>(
      { key, verb: 'reset_packet', scopeId: packetId },
      async () => {
        try {
          const result = await resetPacket({ packetId, reason, clearWorktree });
          if ('reset' in result && result.reset === false && !('salvaged' in result && result.salvaged === true)) {
            return { ok: false, code: 'reset_state_changed', message: result.note, status: 409 };
          }
          return { ok: true, result };
        } catch (error) {
          // Reset failures can follow confirmed process, session, lane, or
          // worktree retirement. Finalize that failure before responding so
          // the same request cannot repeat cleanup against changed state.
          return resetFailureReceipt(error);
        }
      },
    );
    if (outcome.inProgress) {
      return unresolvedIdempotencyResponse(outcome, 'packet reset') ?? operatorSuccess(replayShape(outcome), 202);
    }
    if (!outcome.result.ok) return resetFailureResponse(outcome.result, outcome.replayed);
    return operatorSuccess(replayShape({ ...outcome, result: outcome.result.result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to reset packet.';
    return operatorError('reset_failed', message, 500, error);
  }
}
