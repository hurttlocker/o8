import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { closePacketUnmerged } from '@/lib/orchestrator/close-unmerged';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

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

  const close = await closePacketUnmerged({
    packetId,
    disposition: record.disposition ?? record.reason,
    note: record.note,
  });
  return close.ok
    ? operatorSuccess(close.result)
    : operatorError(close.code, close.message, close.status, close.error);
}
