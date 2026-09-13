import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { resetPacket } from '@/lib/orchestrator/operator-mission-service';
import {
  resetFailureReceipt,
  resetSuccessReceipt,
  type ResetFailureReceipt,
  type ResetReceipt,
} from '@/lib/orchestrator/operator-mission-service/reset-receipt';
import {
  parseResetRecoveryEvidence,
  reconcileUnresolvedResetRequest,
} from '@/lib/orchestrator/operator-mission-service/reset-recovery';
import { readResetRequestHold } from '@/lib/orchestrator/operator-mission-service/reset-recovery-journal';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { asRecord, operatorError, operatorSuccess, parseJsonBody, replayShape } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  // #2313 — operator attestation for a reservation that predates the reset
  // correlation journal. It identifies WHICH interrupted request this is, so it
  // is deliberately excluded from the canonical body and the derived key: the
  // operator resubmits the ORIGINAL request, plus evidence, and reconciles the
  // original reservation instead of minting a second one. Partial or malformed
  // attestation is rejected rather than silently ignored.
  const parsedEvidence = parseResetRecoveryEvidence(record.recovery);
  if (!parsedEvidence.ok) {
    return operatorError('invalid_recovery_evidence', parsedEvidence.message, 400);
  }
  const evidence = parsedEvidence.evidence;
  if (evidence && clearWorktree) {
    // Recovery only ever continues committed-work salvage. A worktree-clearing
    // reset takes no salvage hold and its cleanup is destructive, so there is
    // nothing an attestation could safely resume.
    return operatorError(
      'invalid_recovery_evidence',
      'Recovery attestation applies only to committed-work retry; a worktree-clearing reset cannot be resumed.',
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
      {
        key,
        verb: 'reset_packet',
        scopeId: packetId,
        // #2313 — an owner that exited before its receipt was persisted left the
        // request quarantined forever. Reconciliation replays the journaled
        // receipt, or resumes only the remainder of that exact request under its
        // own generation. It runs for confirmed-dead owners only.
        reconcileUnresolved: () => reconcileUnresolvedResetRequest({
          packetId,
          requestKey: key,
          clearWorktree,
          reason,
          evidence,
        }),
      },
      async () => {
        // Recovery evidence is an attestation for an already-reserved request.
        // If this callback won a new reservation, the supplied key did not
        // identify an interrupted request, so finalise a refusal before any
        // reset side effect can run.
        if (evidence) {
          return {
            ok: false,
            code: 'recovery_request_not_found',
            message: 'Recovery evidence requires the original interrupted request idempotencyKey; no matching request was found.',
            status: 409,
          } satisfies ResetReceipt;
        }
        try {
          return resetSuccessReceipt(await resetPacket({
            packetId,
            reason,
            clearWorktree,
            recovery: { requestKey: key },
          }));
        } catch (error) {
          // Reset failures can follow confirmed process, session, lane, or
          // worktree retirement. Finalize that failure before responding so
          // the same request cannot repeat cleanup against changed state.
          return resetFailureReceipt(error);
        }
      },
    );
    if (outcome.inProgress) {
      if (!outcome.unresolved) return operatorSuccess(replayShape(outcome), 202);
      // Held, never success. Surface the precise durable reason the
      // reconciliation refused so the operator knows what is missing.
      const heldReason = readResetRequestHold(key);
      return operatorError(
        'outcome_unknown',
        heldReason
          ? `The prior packet reset process ended before its receipt was persisted, and it could not be reconciled: ${heldReason}. The exact mutation remains quarantined and was not repeated.`
          : 'The prior packet reset process ended before its receipt was persisted. Its outcome is unknown, so the exact mutation remains quarantined and was not repeated. Inspect current state before taking another action.',
        409,
      );
    }
    if (!outcome.result.ok) return resetFailureResponse(outcome.result, outcome.replayed);
    return operatorSuccess(replayShape({ ...outcome, result: outcome.result.result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to reset packet.';
    return operatorError('reset_failed', message, 500, error);
  }
}
