import { NextRequest } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { steerPacket } from '@/lib/orchestrator/operator-mission-service';
import {
  isPostEffectSteerFailure,
  SteerPacketUnavailableError,
} from '@/lib/orchestrator/operator-mission-service/steer';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { asRecord, operatorError, operatorSuccess, parseJsonBody, replayShape, unresolvedIdempotencyResponse } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SteerFailureReceipt {
  ok: false;
  code: 'steer_unavailable' | 'steer_outcome_unknown';
  message: string;
  outcomeUnknown: boolean;
}

type SteerReceipt =
  | { ok: true; result: Awaited<ReturnType<typeof steerPacket>> }
  | SteerFailureReceipt;

function steerFailureResponse(receipt: SteerFailureReceipt, replayed: boolean) {
  const response = operatorError(receipt.code, receipt.message, 409);
  response.headers.set('x-o8-steer-outcome', receipt.outcomeUnknown ? 'unknown' : 'terminal');
  if (replayed) response.headers.set('x-o8-idempotency-replayed', '1');
  return response;
}

/**
 * POST /api/orchestrator/steer-packet  { packetId, message, idempotencyKey }
 *
 * Layer-3 escalation: nudge a packet's warm session with a follow-up message.
 * Extracted from the in-process MCP `steer_packet` handler (#2 Stage 4) so the
 * lane resolution + status flip run in the Next process — the MCP tool and the
 * `o8 packet steer` CLI both call this one route. Gated by the global
 * middleware (loopback + token under /api/orchestrator/).
 */
export async function POST(request: NextRequest) {
  // Steering a packet is a control-plane verb, gated per-principal (loopback is
  // transport, not identity — fail-closed). The OPERATOR (desktop/MCP/CLI
  // ws-token) and an ENROLLED MOBILE DEVICE (per-device bearer) may steer: the
  // operator's phone is a first-class remote control (#relay managed access). The
  // relay connector forwards the device bearer verbatim and stamps a NON-loopback
  // client-addr, so this route is never loopback-trusted — hence a principal gate
  // here instead of requirePanelAuth (which would 401 the forwarded device). A
  // dispatched WORKER never may steer (incl. others' packets) — it presents the
  // local-worker token via its CLI (§HIGH-4). Absent/unknown credential → 401.
  // Real-path coverage: tests/principal-authz.test.ts.
  const principal = resolveRequestPrincipal(request);
  if (principal === 'worker') {
    return operatorError('forbidden', 'Steering packets is operator-only; a dispatched worker cannot call this.', 403);
  }
  if (principal !== 'operator' && principal !== 'device') {
    return operatorError('unauthorized', 'Steering packets requires the operator credential or an enrolled device.', 401);
  }

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const packetId = typeof record.packetId === 'string' ? record.packetId.trim() : '';
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  const source = typeof record.source === 'string' ? record.source.trim() : undefined;
  if (!packetId) {
    return operatorError('invalid_request', 'packetId is required.', 400);
  }
  if (!message) {
    return operatorError('invalid_request', 'message is required.', 400);
  }

  // #1497 — persisted idempotency. A client timeout+retry (steer's warm-session
  // nudge can outlast the 15s client budget) must not inject the same steer twice.
  const clientKey = typeof record.idempotencyKey === 'string' && record.idempotencyKey.trim()
    ? record.idempotencyKey.trim()
    : null;
  if (!clientKey) {
    return operatorError(
      'idempotency_key_required',
      'idempotencyKey is required to steer a packet.',
      400,
    );
  }
  const canonicalBody = JSON.stringify({ packetId, message, source });
  const key = deriveIdempotencyKey({ verb: 'steer_packet', scopeId: packetId, clientKey, body: canonicalBody });

  try {
    const binding = bindIdempotencyClientMutation({
      namespace: 'steer_packet',
      clientKey,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return operatorError(
        'idempotency_key_conflict',
        'idempotencyKey was already used for a different packet steer.',
        409,
      );
    }
    if (binding.status === 'unavailable') {
      return operatorError(
        'idempotency_store_unavailable',
        'The persisted idempotency store is unavailable; the packet was not steered.',
        503,
      );
    }
    const outcome = await withIdempotency<SteerReceipt>(
      { key, verb: 'steer_packet', scopeId: packetId },
      async () => {
        try {
          return {
            ok: true,
            result: await steerPacket({ packetId, message, source, clientMutationId: clientKey }),
          };
        } catch (error) {
          // Before the service records its first event, failure is provably
          // side-effect free and remains retryable. Once that boundary is
          // crossed, finalize the terminal truth before responding.
          if (!isPostEffectSteerFailure(error)) throw error;
          return {
            ok: false,
            code: error.code,
            message: error.message,
            outcomeUnknown: error.phase === 'outcome_unknown',
          };
        }
      },
    );
    if (outcome.inProgress) return unresolvedIdempotencyResponse(outcome, 'packet steer') ?? operatorSuccess(replayShape(outcome), 202);
    if (!outcome.result.ok) return steerFailureResponse(outcome.result, outcome.replayed);
    return operatorSuccess(replayShape({ ...outcome, result: outcome.result.result }));
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Unable to steer packet.';
    if (error instanceof SteerPacketUnavailableError) {
      return operatorError(error.code, messageText, 409, error);
    }
    return operatorError('steer_failed', messageText, 500, error);
  }
}
