import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { invalidateInboxCache } from '@/lib/mobile/inbox';
import {
  AGENT_CONTROL_RESULT_SCHEMA,
  agentControlIdempotencyBody,
  parseAgentControlRequest,
  type AgentControlResult,
} from '@/lib/agent-control/types';
import {
  performAgentControlAction,
  resolveAgentControlTarget,
} from '@/lib/agent-control/service';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import {
  operatorError,
  operatorSuccess,
  parseJsonBody,
  replayShape,
} from '@/app/api/orchestrator/_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unavailableResponse(result: AgentControlResult, replayed = false) {
  return NextResponse.json({
    ok: false,
    error: {
      code: result.reason === 'kill_unconfirmed'
        ? 'kill_unconfirmed'
        : 'agent_control_unavailable',
      message: result.note,
    },
    result: replayed ? { ...result, replayed: true } : result,
  }, {
    status: 409,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

function authorize(principal: ReturnType<typeof resolveRequestPrincipal>) {
  if (principal === 'operator') return null;
  if (principal === 'worker') {
    return operatorError(
      'forbidden',
      'Shared agent controls are operator-owned; dispatched workers must use their packet-scoped routes.',
      403,
    );
  }
  if (principal === 'device') {
    return operatorError(
      'forbidden',
      'Shared agent controls require the operator credential; enrolled devices use the mobile action route.',
      403,
    );
  }
  return operatorError('unauthorized', 'Agent control requires the operator credential.', 401);
}

async function publishControlReceipt(result: AgentControlResult) {
  const mutationStatus = result.ok
    ? result.status === 'queued' || result.status === 'pending_approval' ? 'queued' : 'completed'
    : 'failed';
  await publishRealtimeMutation({
    mutation: {
      mutationId: result.clientMutationId ?? `agent-control-${Date.now()}`,
      source: 'desktop',
      action: `${result.ref.kind}.${result.action}`,
      runtime: result.target.runtime ?? result.runtime,
      surfaceId: result.target.surfaceId ?? result.surfaceId ?? result.ref.id,
      sessionKey: result.target.sessionKey ?? result.sessionKey,
      laneId: result.target.laneId ?? undefined,
      packetId: result.target.packetId ?? undefined,
      repoPath: result.target.repoPath ?? undefined,
      branch: result.target.branch ?? undefined,
      status: mutationStatus,
      note: result.note,
      createdAt: new Date().toISOString(),
      settledAt: mutationStatus === 'queued' ? undefined : new Date().toISOString(),
    },
    refreshTargets: ['global', 'mobileInbox', ...(result.target.sessionKey ? ['sessionHistory' as const] : [])],
    sessionKeys: result.target.sessionKey ? [result.target.sessionKey] : [],
    fresh: result.ok,
  });
}

export async function POST(request: NextRequest) {
  const parsed = parseAgentControlRequest(await parseJsonBody(request));
  if (!parsed.ok) {
    return operatorError('invalid_request', parsed.error, 400);
  }

  const principal = resolveRequestPrincipal(request);
  const denied = authorize(principal);
  if (denied) return denied;

  const control = parsed.value;
  if (!control.clientMutationId) {
    return operatorError(
      'client_mutation_id_required',
      `clientMutationId is required for ${control.action.kind}.`,
      400,
    );
  }
  const canonicalBody = agentControlIdempotencyBody(control);
  const verb = `agent_control.${control.ref.kind}.${control.action.kind}`;

  try {
    const binding = bindIdempotencyClientMutation({
      namespace: 'agent_control',
      clientKey: control.clientMutationId,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return operatorError(
        'idempotency_conflict',
        'clientMutationId was already used for a different agent-control request.',
        409,
      );
    }
    if (binding.status === 'unavailable') {
      return operatorError(
        'idempotency_unavailable',
        'The persisted idempotency store is unavailable; the action was not run.',
        503,
      );
    }
    const key = deriveIdempotencyKey({
      verb,
      scopeId: control.ref.id,
      clientKey: control.clientMutationId,
      body: canonicalBody,
    });
    const outcome = await withIdempotency(
      { key, verb, scopeId: control.ref.id },
      async () => {
        try {
          return await performAgentControlAction(control);
        } catch (error) {
          // Once the canonical control service is entered, a thrown provider,
          // runtime, lane, or persistence error cannot prove the action was not
          // delivered. Finalize an outcome-unknown receipt so replaying the
          // exact mutation never repeats a possibly completed side effect.
          const target = await resolveAgentControlTarget(control.ref);
          return {
            schema: AGENT_CONTROL_RESULT_SCHEMA,
            ok: false,
            ref: control.ref,
            action: control.action.kind,
            clientMutationId: control.clientMutationId,
            status: 'unavailable',
            note: `The control outcome could not be confirmed and the exact mutation will not be repeated automatically. Inspect the target before taking another action. ${error instanceof Error ? error.message : String(error)}`,
            target,
            retryable: false,
            reason: 'outcome_unknown',
          } satisfies AgentControlResult;
        }
      },
    );
    if (outcome.inProgress) {
      const target = await resolveAgentControlTarget(control.ref);
      if (outcome.unresolved) {
        return unavailableResponse({
          schema: AGENT_CONTROL_RESULT_SCHEMA,
          ok: false,
          ref: control.ref,
          action: control.action.kind,
          clientMutationId: control.clientMutationId,
          status: 'unavailable',
          note: `The prior ${control.action.kind} process ended before its receipt was persisted. The outcome is unknown, so the exact mutation remains quarantined and was not repeated. Inspect the target before taking another action.`,
          target,
          retryable: false,
          reason: 'outcome_unknown',
        }, true);
      }
      return operatorSuccess({
        schema: AGENT_CONTROL_RESULT_SCHEMA,
        ok: true,
        ref: control.ref,
        action: control.action.kind,
        clientMutationId: control.clientMutationId,
        status: 'queued',
        note: `An identical ${control.action.kind} action is already in progress; it was not executed twice.`,
        target,
        replayed: true,
        inProgress: true,
      }, 202);
    }
    if (!outcome.replayed) {
      if (outcome.result.ok) {
        invalidateCommandCenterSnapshotCaches();
        invalidateInboxCache();
      }
      await publishControlReceipt(outcome.result).catch((error) => {
        console.error('[agent-control] receipt publish failed', error);
      });
    }
    if (!outcome.result.ok) {
      return unavailableResponse(outcome.result, outcome.replayed);
    }
    return operatorSuccess(replayShape(outcome));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to perform agent control action.';
    return operatorError('agent_control_failed', message, 500, error);
  }
}
