interface OwnedRuntimeActionPayload {
  ok?: boolean;
  retryable?: boolean;
  reason?: string;
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
