import { NextRequest } from 'next/server';
import { readPacketSpec, writePacketSpec } from '@/lib/orchestrator/packet-spec';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PACKET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function readPacketId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return PACKET_ID_PATTERN.test(trimmed) ? trimmed : null;
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const packetId = readPacketId(request.nextUrl.searchParams.get('packetId'));
  if (!packetId) {
    return operatorError('invalid_request', 'packetId is required.', 400);
  }
  const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(request), packetId);
  if (ownershipRefusal) {
    return operatorError(ownershipRefusal.code, ownershipRefusal.message, 403);
  }

  try {
    const record = await readPacketSpec(packetId);
    return operatorSuccess(record);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read packet spec.';
    return operatorError('read_failed', message, 500, error);
  }
}

export async function PUT(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const packetId = readPacketId(record.packetId);
  if (!packetId) {
    return operatorError('invalid_request', 'packetId is required.', 400);
  }
  const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(request), packetId);
  if (ownershipRefusal) {
    return operatorError(ownershipRefusal.code, ownershipRefusal.message, 403);
  }

  const content = typeof record.content === 'string' ? record.content : '';
  // #856 — silently accepting an empty/whitespace-only spec used to set the
  // mtime stamp ("Updated just now") even though the file ended up blank,
  // giving the operator no signal their content was lost. Reject explicitly
  // and tell them how to clear the spec instead.
  if (content.trim().length === 0) {
    return operatorError(
      'invalid_request',
      'Spec cannot be empty. Delete the spec file directly to remove it, or write at least one non-whitespace character.',
      400,
    );
  }
  try {
    const result = await writePacketSpec(packetId, content);
    return operatorSuccess(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to write packet spec.';
    return operatorError('write_failed', message, 500, error);
  }
}
