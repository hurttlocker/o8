export interface MobileActionIdempotencyIdentity {
  clientMutationId: string;
  action: string;
  sessionKey: string;
  scopeId: string;
}

export interface SerializedMobileActionResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
}

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
  return {
    clientMutationId,
    action,
    sessionKey,
    // Approval ids are authoritative when present, but retain the session in
    // the scope as a collision guard for legacy/session-addressed actions.
    scopeId: JSON.stringify([action, approvalId, sessionKey]),
  };
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
