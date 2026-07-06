import { continueOwnedCodexSession } from '@/lib/codex/owned';
import { escalateInterruptOwnedSurface } from '@/lib/runtime/interrupt-escalation';
import type { RuntimeActionRequest, RuntimeActionResult } from '@/lib/runtime/actions';

function actionUnavailable(
  payload: RuntimeActionRequest,
  surfaceId: string,
  runtime: string,
  note: string,
): RuntimeActionResult {
  return {
    ok: false,
    action: payload.action,
    surfaceId,
    runtime,
    clientMutationId: payload.clientMutationId,
    status: 'unavailable',
    note,
  };
}

export async function performOwnedActionWithoutInventory(
  payload: RuntimeActionRequest,
  surfaceId: string,
): Promise<RuntimeActionResult | null> {
  const runtime = surfaceId.startsWith('codex-owned:')
    ? 'codex'
    : surfaceId.startsWith('claude-code-owned:')
      ? 'claude-code'
      : null;
  if (!runtime) return null;

  if (payload.action === 'steer' || payload.action === 'send_input') {
    const message = payload.message?.trim();
    if (!message) {
      return actionUnavailable(payload, surfaceId, runtime, `message is required to steer an owned ${runtime} session`);
    }
    if (runtime !== 'codex') {
      return actionUnavailable(payload, surfaceId, runtime, 'Claude Code owned sessions do not support resume/steer.');
    }
    try {
      const result = await continueOwnedCodexSession(surfaceId, message);
      return {
        ok: result.ok,
        action: payload.action,
        surfaceId,
        sessionKey: surfaceId,
        runtime,
        clientMutationId: payload.clientMutationId,
        status: result.ok ? 'queued' : 'unavailable',
        note: result.note,
      };
    } catch (error) {
      return actionUnavailable(
        payload,
        surfaceId,
        runtime,
        error instanceof Error ? error.message : 'Owned Codex session could not be steered.',
      );
    }
  }

  if (payload.action === 'stop' || payload.action === 'interrupt') {
    const result = await escalateInterruptOwnedSurface(surfaceId);
    if (!result) return null;
    return {
      ok: result.confirmedDead,
      action: payload.action,
      surfaceId,
      sessionKey: surfaceId,
      runtime,
      clientMutationId: payload.clientMutationId,
      status: result.confirmedDead ? 'completed' : 'unavailable',
      note: result.note,
      aborted: result.confirmedDead,
    };
  }

  return actionUnavailable(
    payload,
    surfaceId,
    runtime,
    `Runtime action ${payload.action} is not wired for owned ${runtime} sessions without inventory metadata.`,
  );
}
