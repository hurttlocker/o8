export const REALTIME_FALLBACK_REFRESH_MS = 5 * 60 * 1000;
export const DEGRADED_FALLBACK_REFRESH_MS = 60 * 1000;

interface DurableRefreshOptions {
  refresh: () => void | Promise<void>;
  intervalMs: number;
  events?: string[];
  windowTarget?: Window;
  documentTarget?: Document;
}

/**
 * Runs a low-frequency resilience refresh without waking a hidden dashboard.
 * Lifecycle events remain the primary signal; the timer only repairs missed
 * events. Concurrent triggers collapse into one trailing refresh.
 */
export function startDurableRefresh({
  refresh,
  intervalMs,
  events = [],
  windowTarget = window,
  documentTarget = document,
}: DurableRefreshOptions): () => void {
  let stopped = false;
  let inFlight = false;
  let refreshPending = false;

  const requestRefresh = () => {
    if (stopped) return;
    if (documentTarget.visibilityState === 'hidden') {
      refreshPending = true;
      return;
    }
    if (inFlight) {
      refreshPending = true;
      return;
    }

    inFlight = true;
    refreshPending = false;
    Promise.resolve()
      .then(refresh)
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (!stopped && refreshPending && documentTarget.visibilityState !== 'hidden') {
          requestRefresh();
        }
      });
  };

  const handleVisibilityChange = () => {
    if (documentTarget.visibilityState !== 'hidden' && refreshPending) {
      requestRefresh();
    }
  };

  const uniqueEvents = [...new Set(events)];
  for (const eventName of uniqueEvents) {
    windowTarget.addEventListener(eventName, requestRefresh);
  }
  documentTarget.addEventListener('visibilitychange', handleVisibilityChange);
  const intervalId = windowTarget.setInterval(requestRefresh, intervalMs);

  return () => {
    stopped = true;
    windowTarget.clearInterval(intervalId);
    documentTarget.removeEventListener('visibilitychange', handleVisibilityChange);
    for (const eventName of uniqueEvents) {
      windowTarget.removeEventListener(eventName, requestRefresh);
    }
  };
}
