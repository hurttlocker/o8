import { bindIdempotencyClientMutation } from '@/lib/orchestrator/idempotency-store';

export interface MobileActionIdempotencyIdentity {
  clientMutationId: string;
  action: string;
  sessionKey: string;
  scopeId: string;
  canonicalBody: string;
}

export interface SerializedMobileActionResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
}

export class MobileActionUncacheableResponseError extends Error {
  constructor(readonly response: SerializedMobileActionResponse) {
    super(`Mobile action returned HTTP ${response.status}; the result remains retryable.`);
  }
}

export type MobileActionIdempotencyRefusal = {
  error: 'idempotency_conflict' | 'idempotency_unavailable';
  message: string;
  status: 409 | 503;
};

/**
 * Only an explicit client-supplied mutation id enables deduplication. The
 * route's generated fallback id must never enter the persisted store because
 * it is different on every retry and therefore cannot protect execution.
 */
export function resolveMobileActionIdempotencyIdentity(
  value: unknown,
): MobileActionIdempotencyIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const clientMutationId = typeof payload.clientMutationId === 'string'
    ? payload.clientMutationId.trim()
    : '';
  if (!clientMutationId) return null;

  const action = typeof payload.action === 'string' ? payload.action.trim() : '';
  const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
  const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId.trim() : '';
  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const attachment = value as Record<string, unknown>;
      return {
        type: attachment.type,
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        content: attachment.content,
      };
    })
    : payload.attachments;
  const canonicalBody = JSON.stringify({
    action,
    sessionKey,
    approvalId,
    message: payload.message,
    attachments,
    runId: payload.runId,
    cwd: payload.cwd,
  });
  return {
    clientMutationId,
    action,
    sessionKey,
    // Approval ids are authoritative when present, but retain the session in
    // the scope as a collision guard for legacy/session-addressed actions.
    scopeId: JSON.stringify([action, approvalId, sessionKey]),
    canonicalBody,
  };
}

export function bindMobileActionIdempotency(
  identity: MobileActionIdempotencyIdentity,
  ttlMs: number,
): MobileActionIdempotencyRefusal | null {
  const binding = bindIdempotencyClientMutation({
    namespace: 'mobile_action',
    clientKey: identity.clientMutationId,
    body: identity.canonicalBody,
    ttlMs,
  });
  if (binding.status === 'conflict') {
    return {
      error: 'idempotency_conflict',
      message: 'clientMutationId was already used for a different mobile action.',
      status: 409,
    };
  }
  if (binding.status === 'unavailable') {
    return {
      error: 'idempotency_unavailable',
      message: 'The persisted idempotency store is unavailable; the action was not run.',
      status: 503,
    };
  }
  return null;
}

/** Capture the JSON response as plain data so it can live in SQLite. */
export async function serializeMobileActionResponse(
  response: Response,
): Promise<SerializedMobileActionResponse> {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
    body: await response.text(),
  };
}

/**
 * Server failures normally release the reservation. A response explicitly
 * marked outcome-unknown crossed an external side-effect boundary, so replay
 * that terminal receipt instead of risking a duplicate provider action.
 */
export async function serializeCacheableMobileActionResponse(
  response: Response,
): Promise<SerializedMobileActionResponse> {
  const serialized = await serializeMobileActionResponse(response);
  if (serialized.status >= 500 && response.headers.get('x-o8-terminal-outcome') !== 'unknown') {
    throw new MobileActionUncacheableResponseError(serialized);
  }
  return serialized;
}

/** Rehydrate the first result or an exact completed replay. */
export function restoreMobileActionResponse(
  value: SerializedMobileActionResponse,
  options: { replayed?: boolean } = {},
): Response {
  const headers = new Headers(value.headers);
  if (options.replayed) headers.set('x-o8-idempotency-replayed', '1');
  return new Response(value.body, {
    status: value.status,
    statusText: value.statusText,
    headers,
  });
}

export function mobileActionInProgressPayload(identity: MobileActionIdempotencyIdentity) {
  return {
    ok: true,
    action: identity.action,
    sessionKey: identity.sessionKey,
    clientMutationId: identity.clientMutationId,
    status: 'queued' as const,
    duplicate: true,
    inProgress: true,
    note: 'An identical mobile action is already in progress; it was not executed again.',
  };
}
