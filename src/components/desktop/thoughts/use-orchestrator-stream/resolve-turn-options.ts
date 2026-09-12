import type { OrchestratorSendOptions } from './types';

export const TURN_OPTIONS_REFRESH_TIMEOUT = Symbol('turn-options-refresh-timeout');

export async function resolveOrchestratorTurnOptions(
  options: OrchestratorSendOptions | undefined,
  signal: AbortSignal,
): Promise<OrchestratorSendOptions | null | undefined> {
  try {
    const liveOptions = await options?.resolveTurnOptions?.(signal);
    return liveOptions ? { ...options, ...liveOptions } : options;
  } catch {
    if (signal.aborted && signal.reason !== TURN_OPTIONS_REFRESH_TIMEOUT) return null;
    // A failed refresh must not discard an operator-authored turn. The
    // captured values are the bounded fallback for this one send.
    return options;
  }
}
