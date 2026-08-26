import { NextRequest } from 'next/server';

import { requirePanelAuth } from '@/lib/panel/auth';
import {
  buildHandoffPacket,
  HandoffPacketError,
  type HandoffIntent,
} from '@/lib/orchestrator/handoff-packet';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function response(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

function text(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== 'string') {
    throw new HandoffPacketError(`${field} must be a string.`, 'invalid_handoff_request', 400);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new HandoffPacketError(`${field} is required.`, 'invalid_handoff_request', 400);
  }
  if (normalized.length > maxLength) {
    throw new HandoffPacketError(
      `${field} must be ${maxLength} characters or fewer.`,
      'invalid_handoff_request',
      400,
    );
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maxLength = 512): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return text(value, field, maxLength);
}

function textList(value: unknown, field: string, maxItems = 50): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new HandoffPacketError(
      `${field} must be an array with at most ${maxItems} entries.`,
      'invalid_handoff_request',
      400,
    );
  }
  return value.map((item, index) => text(item, `${field}[${index}]`, 2_000));
}

function intent(value: unknown): HandoffIntent | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HandoffPacketError('intent must be an object.', 'invalid_handoff_intent', 400);
  }
  const record = value as Record<string, unknown>;
  const objective = text(record.objective, 'intent.objective', 4_000);
  if (record.rejected !== undefined && (!Array.isArray(record.rejected) || record.rejected.length > 50)) {
    throw new HandoffPacketError(
      'intent.rejected must be an array with at most 50 entries.',
      'invalid_handoff_intent',
      400,
    );
  }
  const rejected = Array.isArray(record.rejected)
    ? record.rejected.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new HandoffPacketError(
          `intent.rejected[${index}] must be an object.`,
          'invalid_handoff_intent',
          400,
        );
      }
      const rejectedRecord = item as Record<string, unknown>;
      return {
        approach: text(rejectedRecord.approach, `intent.rejected[${index}].approach`, 2_000),
        reason: text(rejectedRecord.reason, `intent.rejected[${index}].reason`, 2_000),
      };
    })
    : [];
  return { objective, constraints: textList(record.constraints, 'intent.constraints'), rejected };
}

export async function POST(request: NextRequest): Promise<Response> {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  try {
    const rawBody = await request.json().catch(() => null) as unknown;
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      throw new HandoffPacketError('The request body must be an object.', 'invalid_handoff_request', 400);
    }
    const body = rawBody as Record<string, unknown>;
    const to = body?.to && typeof body.to === 'object' && !Array.isArray(body.to)
      ? body.to as Record<string, unknown>
      : null;
    if (!to) {
      throw new HandoffPacketError('to must be an object.', 'invalid_handoff_request', 400);
    }
    const packet = await buildHandoffPacket({
      threadId: text(body.threadId, 'threadId'),
      to: {
        backend: text(to.backend, 'to.backend', 128),
        model: text(to.model, 'to.model', 256),
      },
      intent: intent(body.intent),
      laneId: optionalText(body.laneId, 'laneId'),
      verifiedClaims: 'verifiedClaims' in body ? textList(body.verifiedClaims, 'verifiedClaims', 100) : undefined,
      unverifiedClaims: 'unverifiedClaims' in body ? textList(body.unverifiedClaims, 'unverifiedClaims', 100) : undefined,
    });
    return response({ schema: 'o8/handoff.packet.response/v1', ok: true, packet }, 200);
  } catch (error) {
    if (error instanceof HandoffPacketError) {
      return response({
        schema: 'o8/handoff.packet.error/v1',
        ok: false,
        error: { code: error.code, message: error.message },
      }, error.status);
    }
    console.error('[orchestrator-handoff] Packet build failed:', error);
    return response({
      schema: 'o8/handoff.packet.error/v1',
      ok: false,
      error: { code: 'handoff_packet_failed', message: 'The handoff packet could not be built.' },
    }, 500);
  }
}
