export interface WsHealthIdentity {
  product?: unknown;
  instanceId?: unknown;
  bootId?: unknown;
}

export type StalePortDecision =
  | { action: 'kill'; reason: 'stale-o8-instance' }
  | { action: 'exit'; reason: 'foreign-process' | 'same-boot' | 'no-answer' };

export function decideStalePortRecovery(
  own: { instanceId: string; bootId: string },
  health: WsHealthIdentity | null,
): StalePortDecision {
  if (!health) return { action: 'exit', reason: 'no-answer' };
  if (health.product !== 'o8' || health.instanceId !== own.instanceId) {
    return { action: 'exit', reason: 'foreign-process' };
  }
  if (health.bootId === own.bootId) {
    return { action: 'exit', reason: 'same-boot' };
  }
  return { action: 'kill', reason: 'stale-o8-instance' };
}

export async function fetchWsHealthIdentity(port: number, timeoutMs = 350): Promise<WsHealthIdentity | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const payload = await res.json() as WsHealthIdentity;
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}
