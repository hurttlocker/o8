import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { closePacketUnmerged } from '@/lib/orchestrator/close-unmerged';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { asRecord, operatorError, operatorSuccess, parseJsonBody, replayShape, unresolvedIdempotencyResponse } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  if (resolveRequestPrincipal(request) !== 'operator') {
    return operatorError('forbidden', 'Discarding packets is operator-only; a dispatched worker cannot call this.', 403);
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
  const clientKey = typeof record.clientMutationId === 'string' ? record.clientMutationId.trim() : '';
  if (!clientKey) return operatorError('client_mutation_id_required', 'clientMutationId is required.', 400);
  const disposition = record.disposition ?? record.reason;
  const note = record.note;
  if (record.acknowledgeMissingWorktree !== undefined
    && typeof record.acknowledgeMissingWorktree !== 'boolean') {
    return operatorError('invalid_request', 'acknowledgeMissingWorktree must be a boolean.', 400);
  }
  const acknowledgeMissingWorktree = record.acknowledgeMissingWorktree === true;
  const canonicalBody = JSON.stringify({
    packetId,
    disposition,
    note,
    acknowledgeMissingWorktree,
  });
  try {
    const binding = bindIdempotencyClientMutation({
      namespace: 'discard_packet',
      clientKey,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return operatorError('idempotency_conflict', 'clientMutationId was used for another close request.', 409);
    }
    if (binding.status === 'unavailable') {
      return operatorError('idempotency_unavailable', 'The close receipt store is unavailable.', 503);
    }
    const outcome = await withIdempotency({
      key: deriveIdempotencyKey({ verb: 'discard_packet', scopeId: packetId, clientKey, body: canonicalBody }),
      verb: 'discard_packet',
      scopeId: packetId,
    }, async () => closePacketUnmerged({
      packetId,
      disposition,
      note,
      acknowledgeMissingWorktree,
    }));
    if (outcome.inProgress) return unresolvedIdempotencyResponse(outcome, 'packet close') ?? operatorSuccess(replayShape(outcome), 202);
    const close = outcome.result;
    if (!close.ok) {
      const response = operatorError(close.code, close.message, close.status, close.error);
      if (outcome.replayed) response.headers.set('x-o8-idempotency-replayed', '1');
      return response;
    }
    return operatorSuccess(replayShape({ ...outcome, result: close.result }));
  } catch (error) {
    return operatorError('discard_failed', error instanceof Error ? error.message : 'Unable to close packet.', 500);
  }
}
