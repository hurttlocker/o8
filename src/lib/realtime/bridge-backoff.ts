export interface RealtimeBridgeBackoffState {
  failureCount: number;
  down: boolean;
  nextRetryAt: number;
}

export interface RealtimeBridgeBackoffOptions {
  threshold?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export interface RealtimeBridgeBackoffResult {
  transition: 'down' | 'up' | null;
  delayMs: number;
}

const DEFAULT_THRESHOLD = 5;
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

export function createRealtimeBridgeBackoffState(): RealtimeBridgeBackoffState {
  return {
    failureCount: 0,
    down: false,
    nextRetryAt: 0,
  };
}

export function canAttemptRealtimeBridge(state: RealtimeBridgeBackoffState, now = Date.now()): boolean {
  return now >= state.nextRetryAt;
}

export function getRealtimeBridgeRetryDelay(state: RealtimeBridgeBackoffState, now = Date.now()): number {
  return Math.max(0, state.nextRetryAt - now);
}

export function recordRealtimeBridgeFailure(
  state: RealtimeBridgeBackoffState,
  now = Date.now(),
  options: RealtimeBridgeBackoffOptions = {},
): RealtimeBridgeBackoffResult {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  state.failureCount += 1;
  let delayMs = 0;
  if (state.failureCount >= threshold) {
    const exponent = Math.max(0, state.failureCount - threshold);
    delayMs = Math.min(maxDelayMs, initialDelayMs * (2 ** exponent));
    state.nextRetryAt = now + delayMs;
  }

  const transition = !state.down && state.failureCount >= threshold ? 'down' : null;
  if (transition) state.down = true;
  return { transition, delayMs };
}

export function recordRealtimeBridgeSuccess(
  state: RealtimeBridgeBackoffState,
): RealtimeBridgeBackoffResult {
  const transition = state.down ? 'up' : null;
  state.failureCount = 0;
  state.down = false;
  state.nextRetryAt = 0;
  return { transition, delayMs: 0 };
}
