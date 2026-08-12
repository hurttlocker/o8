import { NextRequest } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { stopMission } from '@/lib/orchestrator/mission-stop';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { requirePanelAuth } from '@/lib/panel/auth';
import { asRecord, operatorError, operatorSuccess, parseJsonBody, replayShape, unresolvedIdempotencyResponse } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type StopMissionResult = Awaited<ReturnType<typeof stopMission>>;

type StopMissionReceipt =
  | { ok: true; result: StopMissionResult }
  | {
      ok: false;
      code: 'mission_stop_incomplete';
      message: string;
      result: StopMissionResult;
    };

function partialStopResponse(receipt: Extract<StopMissionReceipt, { ok: false }>, replayed: boolean) {
  return Response.json({
    ok: false,
    error: { code: receipt.code, message: receipt.message },
    result: receipt.result,
    ...(replayed ? { replayed: true } : {}),
  }, {
    status: 409,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      ...(replayed ? { 'x-o8-idempotency-replayed': '1' } : {}),
    },
  });
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  if (resolveRequestPrincipal(request) !== 'operator') {
    return operatorError('forbidden', 'Stopping missions is operator-only; a dispatched worker cannot call this.', 403);
  }

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const missionId = typeof record.missionId === 'string' ? record.missionId.trim() : '';
  if (!missionId) {
    return operatorError('invalid_request', 'missionId is required.', 400);
  }

  const clientKey = typeof record.idempotencyKey === 'string' && record.idempotencyKey.trim()
    ? record.idempotencyKey.trim()
    : typeof record.clientMutationId === 'string' && record.clientMutationId.trim()
      ? record.clientMutationId.trim()
      : null;
  if (!clientKey) {
    return operatorError(
      'idempotency_key_required',
      'idempotencyKey or clientMutationId is required to stop a mission.',
      400,
    );
  }
  const canonicalBody = JSON.stringify({ missionId });

  try {
    const binding = bindIdempotencyClientMutation({
      namespace: 'mission_stop',
      clientKey,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return operatorError(
        'idempotency_key_conflict',
        'The mission-stop correlation id was already used for another mission.',
        409,
      );
    }
    if (binding.status === 'unavailable') {
      return operatorError(
        'idempotency_store_unavailable',
        'The persisted idempotency store is unavailable; the mission was not stopped.',
        503,
      );
    }
    const outcome = await withIdempotency<StopMissionReceipt>({
      key: deriveIdempotencyKey({
        verb: 'mission_stop',
        scopeId: missionId,
        clientKey,
        body: canonicalBody,
      }),
      verb: 'mission_stop',
      scopeId: missionId,
    }, async () => {
      const result = await stopMission(missionId);
      const failed = result.packets.filter((packet) => packet.status === 'stop-failed');
      if (failed.length === 0) return { ok: true, result };
      return {
        ok: false,
        code: 'mission_stop_incomplete',
        message: `Mission stop was incomplete: ${failed.length} packet${failed.length === 1 ? '' : 's'} could not be stopped.`,
        result,
      };
    });
    if (outcome.inProgress) return unresolvedIdempotencyResponse(outcome, 'mission stop') ?? operatorSuccess(replayShape(outcome), 202);
    if (!outcome.result.ok) return partialStopResponse(outcome.result, outcome.replayed);
    return operatorSuccess(replayShape({ ...outcome, result: outcome.result.result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to stop mission.';
    return operatorError('stop_mission_failed', message, 500, error);
  }
}
