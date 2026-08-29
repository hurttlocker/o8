import { NextRequest } from 'next/server';

import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  createPacketReceiptForClosedPacket,
  listStoredPacketReceipts,
} from '@/lib/receipts/packet-receipt';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function artifactSummary(receipt: ReturnType<typeof listStoredPacketReceipts>[number]) {
  return {
    id: receipt.artifact.id,
    relPath: receipt.artifact.relPath,
    bytes: receipt.artifact.bytes,
    createdAt: receipt.artifact.createdAt,
    receipt: receipt.receipt,
  };
}

function requireOperator(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (resolveRequestPrincipal(request) !== 'operator') {
    return operatorError('forbidden', 'Packet receipts are operator-only.', 403);
  }
  return null;
}

export async function GET(request: NextRequest) {
  const denied = requireOperator(request);
  if (denied) return denied;
  const packetId = request.nextUrl.searchParams.get('packetId')?.trim() ?? '';
  if (!packetId) return operatorError('invalid_request', 'packetId is required.', 400);
  const receipts = listStoredPacketReceipts(packetId).map(artifactSummary);
  return operatorSuccess({ packetId, count: receipts.length, receipts });
}

export async function POST(request: NextRequest) {
  const denied = requireOperator(request);
  if (denied) return denied;
  const body = asRecord(await parseJsonBody(request));
  const packetId = typeof body?.packetId === 'string' ? body.packetId.trim() : '';
  if (!packetId) return operatorError('invalid_request', 'packetId is required.', 400);
  try {
    const receipt = await createPacketReceiptForClosedPacket({ packetId, source: 'manual' });
    return operatorSuccess(artifactSummary(receipt));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create packet receipt.';
    const status = /was not found|No lane was found/.test(message) ? 404 : 409;
    return operatorError('receipt_unavailable', message, status);
  }
}
