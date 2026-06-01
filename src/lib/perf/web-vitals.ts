/**
 * Lightweight client-side Web Vitals observer for app-speed benchmarks.
 *
 * Emit-only: records browser timing entries and prints one console line per
 * reporting trigger without mutating rendered state.
 */

let webVitalsObserverStarted = false;

type LayoutShiftPerformanceEntry = PerformanceEntry & {
  value?: number;
  hadRecentInput?: boolean;
};

type EventTimingPerformanceEntry = PerformanceEntry & {
  duration?: number;
};

const VITALS_SETTLE_MS = 10_000;

export function startWebVitalsObserver(): void {
  if (
    webVitalsObserverStarted
    || typeof window === 'undefined'
    || typeof document === 'undefined'
    || typeof PerformanceObserver === 'undefined'
  ) {
    return;
  }

  webVitalsObserverStarted = true;

  let lcp = 0;
  let cls = 0;
  let inp = 0;
  let hiddenLogged = false;

  const logVitals = () => {
    console.log('[perf][vitals] LCP=%dms INP=%dms CLS=%s', Math.round(lcp), Math.round(inp), cls.toFixed(3));
  };

  try {
    const lcpObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        lcp = entry.startTime;
      }
    });
    lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { /* older WebKit may not support LCP */ }

  try {
    const clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as LayoutShiftPerformanceEntry[]) {
        if (entry.hadRecentInput) continue;
        cls += typeof entry.value === 'number' ? entry.value : 0;
      }
    });
    clsObserver.observe({ type: 'layout-shift', buffered: true });
  } catch { /* older WebKit may not support layout-shift */ }

  try {
    const inpObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as EventTimingPerformanceEntry[]) {
        const duration = typeof entry.duration === 'number' ? entry.duration : 0;
        if (duration > inp) inp = duration;
      }
    });
    // Approximate INP for benchmarking; real INP requires the p98 interaction.
    inpObserver.observe({
      type: 'event',
      buffered: true,
      durationThreshold: 40,
    } as PerformanceObserverInit & { durationThreshold: number });
  } catch { /* older WebKit may not support Event Timing */ }

  try {
    document.addEventListener('visibilitychange', () => {
      if (hiddenLogged || document.visibilityState !== 'hidden') return;
      hiddenLogged = true;
      logVitals();
    });
  } catch { /* noop */ }

  // Give the first page interaction/render bursts time to settle before the
  // benchmark snapshot prints, even when the tab stays visible.
  window.setTimeout(logVitals, VITALS_SETTLE_MS);
}
