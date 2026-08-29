// #1476 lie 2 — a failed→heal blip on the discovery side surfaced as
// status:'failed' for a single snapshot while the worker was alive and
// mid-flow; callers polling in that window read a terminal-looking verdict.
// Hysteresis: 'failed' must persist for FAILED_CONFIRM_MS before it surfaces;
// until then the session reports its last known non-failed status. A session
// whose FIRST observation is failed reports failed immediately (no history to
// mask with — that's a genuinely dead discovery, not a blip).
const FAILED_CONFIRM_MS = 90_000;
const failureDebounceBySession = new Map<string, { lastGood: string; failedSince: number | null }>();

export function debouncedSessionStatus(sessionKey: string, status: string): string {
  if (failureDebounceBySession.size > 512 && !failureDebounceBySession.has(sessionKey)) {
    const oldest = failureDebounceBySession.keys().next().value;
    if (oldest !== undefined) failureDebounceBySession.delete(oldest);
  }
  const entry = failureDebounceBySession.get(sessionKey) ?? { lastGood: status, failedSince: null };
  if (status !== 'failed') {
    entry.lastGood = status;
    entry.failedSince = null;
    failureDebounceBySession.set(sessionKey, entry);
    return status;
  }
  if (entry.failedSince === null) entry.failedSince = Date.now();
  failureDebounceBySession.set(sessionKey, entry);
  if (entry.lastGood === 'failed' || Date.now() - entry.failedSince >= FAILED_CONFIRM_MS) {
    return 'failed';
  }
  return entry.lastGood;
}
