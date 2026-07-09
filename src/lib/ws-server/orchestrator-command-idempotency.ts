export type OrchestratorCommandAckCorrelation = {
  clientMessageId?: string;
  clientMutationId?: string;
};

export type OrchestratorSendAckState = 'accepted' | 'duplicate-in-progress' | 'replayed';
export type OrchestratorInterruptAckState = 'accepted' | 'already-interrupted' | 'not-running';

/**
 * The desktop web client historically called this `clientMessageId`, while the
 * native app shipped the same correlation value as `clientMutationId`. Accept
 * both during the compatibility window and always prefer the message-specific
 * name when both are present.
 */
export function resolveOrchestratorCommandCorrelationId(
  message: Record<string, unknown>,
): string | undefined {
  const clientMessageId = typeof message.clientMessageId === 'string'
    ? message.clientMessageId.trim()
    : '';
  if (clientMessageId) return clientMessageId;

  const clientMutationId = typeof message.clientMutationId === 'string'
    ? message.clientMutationId.trim()
    : '';
  return clientMutationId || undefined;
}

/** Mirror the resolved id into both wire aliases so either client generation
 * can correlate the ACK without a coordinated flag day. */
export function orchestratorCommandAckCorrelation(
  correlationId: string | undefined,
): OrchestratorCommandAckCorrelation {
  if (!correlationId) return {};
  return {
    clientMessageId: correlationId,
    clientMutationId: correlationId,
  };
}

/**
 * Scope a send reservation to its complete orchestrator route. A caller may
 * legitimately reuse a correlation id on another thread/backend, so those
 * identities must not collide in the persisted idempotency store.
 */
export function orchestratorSendIdempotencyScope(input: {
  repoPath: string;
  backend: string;
  agent?: string;
  threadId?: string | null;
}): string {
  return JSON.stringify([
    input.repoPath,
    input.backend,
    input.agent ?? '',
    input.threadId ?? '',
  ]);
}

export function duplicateOrchestratorSendAck(inProgress: boolean): {
  state: Exclude<OrchestratorSendAckState, 'accepted'>;
  duplicate: true;
} {
  return {
    state: inProgress ? 'duplicate-in-progress' : 'replayed',
    duplicate: true,
  };
}

export function orchestratorInterruptAckDisposition(input: {
  hasController: boolean;
  alreadyAborted: boolean;
}): {
  state: OrchestratorInterruptAckState;
  interrupted: boolean;
  duplicate: boolean;
} {
  if (!input.hasController) {
    return { state: 'not-running', interrupted: false, duplicate: false };
  }
  if (input.alreadyAborted) {
    return { state: 'already-interrupted', interrupted: true, duplicate: true };
  }
  return { state: 'accepted', interrupted: true, duplicate: false };
}
