import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  dispatchMission,
  MissionNotFoundError,
  prepareMissionDispatch,
  resolveMissionDispatchTarget,
} from '@/lib/orchestrator/operator-mission-service';
import { DispatchPreflightError } from '@/lib/runtimes/shared/auth-detect';
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

  const body = await parseJsonBody(request);
  if (body === null) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const record = asRecord(body) ?? {};
  const missionId = typeof record.missionId === 'string' && record.missionId.trim()
    ? record.missionId.trim()
    : undefined;
  let targetMissionId: string;
  try {
    targetMissionId = resolveMissionDispatchTarget(missionId);
  } catch (error) {
    if (error instanceof MissionNotFoundError) {
      return operatorError('not_found', error.message, 404);
    }
    const message = error instanceof Error ? error.message : 'Unable to resolve the mission.';
    return operatorError('dispatch_failed', message, 500, error);
  }

  // dispatchMission awaits the full worker launch (Codex spawn + worktree
  // creation), which can take minutes — blocking the HTTP response that whole
  // time. `wait:false` (the CLI default) fires the launch on the persistent Next
  // server and returns once it's initiated; callers track progress via
  // `/api/orchestrator/status`. `wait` defaults to true so the MCP dispatch_mission
  // tool keeps its synchronous dispatched-count contract.
  // #1497 — persisted idempotency. Dispatch is naturally REPEATABLE (dispatch
  // again after queuing more work), so unlike steer/rerun we engage the guard
  // ONLY when a client supplies an explicit idempotencyKey (its retry-dedup
  // intent). Absent a key, behaviour is unchanged — no derived-hash guard that
  // would wrongly block a legitimate re-dispatch within the TTL window.
  const clientKey = typeof record.idempotencyKey === 'string' && record.idempotencyKey.trim()
    ? record.idempotencyKey.trim()
    : null;
  const wait = record.wait !== false;
  const canonicalBody = JSON.stringify({ missionId: targetMissionId, wait });
  if (clientKey) {
    const binding = bindIdempotencyClientMutation({
      namespace: 'dispatch_mission',
      clientKey,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return operatorError('idempotency_conflict', 'idempotencyKey was used for another dispatch request.', 409);
    }
    if (binding.status === 'unavailable') {
      return operatorError('idempotency_unavailable', 'The dispatch receipt store is unavailable.', 503);
    }
  }
  const idemKey = clientKey
    ? deriveIdempotencyKey({
        verb: 'dispatch_mission',
        scopeId: targetMissionId,
        clientKey,
        body: canonicalBody,
      })
    : null;
  if (!wait) {
    // Persist the dispatch admission before finalizing the accepted receipt.
    // Runtime launch remains asynchronous, but an API-process exit can no
    // longer lose the explicit held -> queued transition; the headless loop
    // resumes it from durable mission state after restart.
    if (idemKey) {
      const outcome = await withIdempotency(
        { key: idemKey, verb: 'dispatch_mission', scopeId: targetMissionId },
        async () => {
          const admitted = await prepareMissionDispatch({ missionId: targetMissionId });
          if (admitted.blocked) {
            return { initiated: false, async: true, missionId: targetMissionId, blocked: true };
          }
          void dispatchMission({ missionId: targetMissionId }).catch((error) => {
            console.error('[orchestrator] async dispatch failed:', error instanceof Error ? error.message : error);
          });
          return { initiated: true, async: true, missionId: targetMissionId };
        },
      );
      if (outcome.inProgress) return unresolvedIdempotencyResponse(outcome, 'mission dispatch') ?? operatorSuccess(replayShape(outcome), 202);
      return operatorSuccess(replayShape(outcome));
    }
    const admitted = await prepareMissionDispatch({ missionId: targetMissionId });
    if (admitted.blocked) {
      return operatorError(
        'dispatch_blocked',
        'The mission has an active lifecycle hold and was not dispatched.',
        409,
      );
    }
    void dispatchMission({ missionId: targetMissionId }).catch((error) => {
      console.error('[orchestrator] async dispatch failed:', error instanceof Error ? error.message : error);
    });
    return operatorSuccess({ initiated: true, async: true, missionId: targetMissionId });
  }

  try {
    if (idemKey) {
      const outcome = await withIdempotency(
        {
          key: idemKey,
          verb: 'dispatch_mission',
          scopeId: targetMissionId,
          reconcileUnresolved: () => dispatchMission({ missionId: targetMissionId }),
        },
        () => dispatchMission({ missionId: targetMissionId }),
      );
      if (outcome.inProgress) return unresolvedIdempotencyResponse(outcome, 'mission dispatch') ?? operatorSuccess(replayShape(outcome), 202);
      return operatorSuccess(replayShape(outcome));
    }
    const result = await dispatchMission({ missionId: targetMissionId });
    return operatorSuccess(result);
  } catch (error) {
    if (error instanceof DispatchPreflightError) {
      return operatorError(error.code, `${error.status.detail} ${error.status.fix}`, 400, {
        runtime: error.status.runtime,
        house: error.status.house,
        installed: error.status.installed,
        authenticated: error.status.authenticated,
        unavailableReason: error.status.unavailableReason,
      });
    }
    if (error instanceof MissionNotFoundError) {
      return operatorError('not_found', error.message, 404);
    }
    const message = error instanceof Error ? error.message : 'Unable to dispatch mission.';
    return operatorError('dispatch_failed', message, 500, error);
  }
}
