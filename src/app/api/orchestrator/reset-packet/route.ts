import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { resetPacket } from '@/lib/orchestrator/operator-mission-service';
import { deriveIdempotencyKey, withIdempotency } from '@/lib/orchestrator/idempotency-store';
import { asRecord, operatorError, operatorSuccess, parseJsonBody, replayShape } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  const key = deriveIdempotencyKey({
    verb: 'reset_packet',
    scopeId: packetId,
    clientKey,
    body: `${clearWorktree ? 'clear' : 'keep'}:${reason ?? ''}`,
  });

  try {
    const outcome = await withIdempotency(
      { key, verb: 'reset_packet', scopeId: packetId },
      () => resetPacket({ packetId, reason, clearWorktree }),
    );
    return operatorSuccess(replayShape(outcome));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to reset packet.';
    return operatorError('reset_failed', message, 500, error);
  }
}
