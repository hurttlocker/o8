import 'server-only';
import { getAppUpdateState } from './relaunch-state';

export const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;
const CHECK_WAIT_MS = 25_000;
let requestedAt: string | null = null;
let pending: Promise<boolean> | null = null;

export function checkFreshness() {
  const checkedAt = getAppUpdateState().check.checkedAt;
  const timestamp = Date.parse(checkedAt ?? '');
  const checkAgeMs = Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : null;
  return { checkedAt, checkAgeMs };
}

export function getRequestedCheckTime() {
  return requestedAt;
}

/** The native loop reads this request through the existing state API, without a webview. */
export async function ensureFreshUpdateCheck(): Promise<boolean> {
  const age = checkFreshness().checkAgeMs;
  if (age !== null && age < UPDATE_CHECK_INTERVAL_MS) return true;
  if (pending) return pending;
  requestedAt = new Date().toISOString();
  const started = Date.now();
  pending = (async () => {
    while (Date.now() - started < CHECK_WAIT_MS) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const time = Date.parse(getAppUpdateState().check.checkedAt ?? '');
      if (Number.isFinite(time) && time >= started) return true;
    }
    return false;
  })().finally(() => { pending = null; requestedAt = null; });
  return pending;
}

export const UPDATE_RETRY = { retryable: true, retryAfterMs: 5_000,
  hint: 'The desktop updater or bridge is still starting. Retry in 5 seconds.' };
