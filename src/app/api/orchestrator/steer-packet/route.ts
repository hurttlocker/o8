import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { steerPacket } from '@/lib/orchestrator/operator-mission-service';
import { SteerPacketUnavailableError } from '@/lib/orchestrator/operator-mission-service/steer';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/orchestrator/steer-packet  { packetId, message }
 *
 * Layer-3 escalation: nudge a packet's warm session with a follow-up message.
 * Extracted from the in-process MCP `steer_packet` handler (#2 Stage 4) so the
 * lane resolution + status flip run in the Next process — the MCP tool and the
 * `o8 packet steer` CLI both call this one route. Gated by the global
 * middleware (loopback + token under /api/orchestrator/).
 */
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  // Operator/orchestrator-only: steering a packet is a control-plane verb; a
  // dispatched worker has no business steering any packet (incl. others'). It
  // presents the local-worker token via its CLI (§HIGH-4).
  if (resolveRequestPrincipal(request) === 'worker') {
    return operatorError('forbidden', 'Steering packets is operator-only; a dispatched worker cannot call this.', 403);
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

  try {
    const result = await steerPacket({ packetId, message, source });
    return operatorSuccess(result);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Unable to steer packet.';
    if (error instanceof SteerPacketUnavailableError) {
      return operatorError(error.code, messageText, 409, error);
    }
    return operatorError('steer_failed', messageText, 500, error);
  }
}
