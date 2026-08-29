// Failed discovery must survive one debounce window before it becomes operator truth.
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
