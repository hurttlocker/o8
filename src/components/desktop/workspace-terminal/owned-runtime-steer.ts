import { fetchCorrelatedActionReceipt } from '@/lib/orchestrator/action-receipt';

interface OwnedRuntimeActionPayload {
  ok?: boolean;
  retryable?: boolean;
  reason?: string;
  note?: string;
  error?: string;
  inProgress?: boolean;
  status?: string;
}

interface OwnedRuntimeInventoryAgent {
  sessionKey?: string;
  runtimeSurface?: {
    id?: string;
    capabilities?: {
      sendInput?: boolean;
    };
  };
}

export function ownedRuntimeCanAcceptInput(
  agents: unknown[],
  sessionKey: string,
): boolean {
  const typedAgents = agents.filter((entry): entry is OwnedRuntimeInventoryAgent => (
    Boolean(entry && typeof entry === 'object')
  ));
  const agent = typedAgents.find((entry) => (
    entry.sessionKey === sessionKey || entry.runtimeSurface?.id === sessionKey
  ));
  return agent?.runtimeSurface?.capabilities?.sendInput === true;
}

export function shouldHoldOwnedRuntimeSteer(
  responseOk: boolean,
  payload: OwnedRuntimeActionPayload | null,
): boolean {
  return !responseOk
    && payload?.ok === false
    && payload.retryable === true
    && payload.reason === 'surface_not_ready';
}

export function fetchOwnedRuntimeSteerReceipt(surfaceId: string, message: string) {
  const requestBody = JSON.stringify({
    action: 'steer',
    surfaceId,
    clientMutationId: crypto.randomUUID(),
    message,
  });
  return fetchCorrelatedActionReceipt<OwnedRuntimeActionPayload>('/api/runtime/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: requestBody,
  });
}
