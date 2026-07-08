import { describe, it, expect, vi, afterEach } from 'vitest';
import { WsWatchdog } from './health-watchdog';

/**
 * Deterministic driver: an injected monotonic clock + a captured scheduler
 * callback so the test advances "loop time" and fires samples by hand. This is
 * the fake-timer discipline — no wall-clock sleeps, fully reproducible.
 */
function makeDriver(overrides: Partial<{
  intervalMs: number;
  thresholdMs: number;
  sustainedSamples: number;
}> = {}) {
  let clock = 1_000_000; // monotonic ms
  let wall = 1_700_000_000_000; // epoch ms
  const logs: string[] = [];
  let scheduled: (() => void) | null = null;
  let cleared = false;

  const watchdog = new WsWatchdog({
    intervalMs: overrides.intervalMs ?? 1000,
    thresholdMs: overrides.thresholdMs ?? 250,
    sustainedSamples: overrides.sustainedSamples ?? 3,
    nowMs: () => clock,
    wallClock: () => wall,
    scheduler: (cb) => {
      scheduled = cb;
      return { unref: () => {} };
    },
    cancelScheduler: () => {
      cleared = true;
    },
    log: (m) => logs.push(m),
  });

  return {
    watchdog,
    logs,
    isScheduled: () => scheduled !== null,
    wasCleared: () => cleared,
    /** Advance monotonic clock by `ms`, then fire one sample. */
    advanceAndSample(ms: number) {
      clock += ms;
      scheduled?.();
    },
    setWall(v: number) {
      wall = v;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WsWatchdog', () => {
  it('registers an interval on start and clears it on stop', () => {
    const d = makeDriver();
    expect(d.isScheduled()).toBe(false);
    d.watchdog.start();
    expect(d.isScheduled()).toBe(true);
    d.watchdog.stop();
    expect(d.wasCleared()).toBe(true);
  });

  it('stays healthy (no wedge, no log) when samples fire on cadence', () => {
    const d = makeDriver({ intervalMs: 1000, thresholdMs: 250 });
    d.watchdog.start();
    // Each gap is exactly the interval → lag 0.
    for (let i = 0; i < 10; i += 1) d.advanceAndSample(1000);
    const s = d.watchdog.getStats();
    expect(s.samples).toBe(10);
    expect(s.maxLagMs).toBe(0);
    expect(s.wedgeCount).toBe(0);
    expect(s.wedged).toBe(false);
    expect(s.lastWedgeAt).toBeNull();
    expect(d.logs).toHaveLength(0);
  });

  it('detects a wedge only after N consecutive high samples and logs once', () => {
    const d = makeDriver({ intervalMs: 1000, thresholdMs: 250, sustainedSamples: 3 });
    d.watchdog.start();

    // Sample 1: 300ms over → high (1 consecutive), not yet a wedge.
    d.advanceAndSample(1300);
    expect(d.watchdog.getStats().wedgeCount).toBe(0);
    expect(d.watchdog.getStats().consecutiveHighSamples).toBe(1);
    expect(d.logs).toHaveLength(0);

    // Sample 2: still high (2 consecutive), not yet a wedge.
    d.advanceAndSample(1400);
    expect(d.watchdog.getStats().wedgeCount).toBe(0);
    expect(d.logs).toHaveLength(0);

    // Sample 3: crosses the sustained threshold → wedge onset, one log.
    d.setWall(1_700_000_055_555);
    d.advanceAndSample(1500);
    const s = d.watchdog.getStats();
    expect(s.wedgeCount).toBe(1);
    expect(s.wedged).toBe(true);
    expect(s.lastWedgeAt).toBe(1_700_000_055_555);
    expect(s.lastWedgeLagMs).toBe(500);
    expect(s.maxLagMs).toBe(500);
    expect(d.logs).toHaveLength(1);
    expect(d.logs[0]).toContain('[ws-health]');
    expect(d.logs[0]).toContain('wedge detected');

    // Sample 4: still wedged — must NOT log again (once per episode).
    d.advanceAndSample(1300);
    expect(d.watchdog.getStats().wedgeCount).toBe(1);
    expect(d.logs).toHaveLength(1);
  });

  it('logs recovery and resets the counter when the loop comes back healthy', () => {
    const d = makeDriver({ intervalMs: 1000, thresholdMs: 250, sustainedSamples: 3 });
    d.watchdog.start();
    d.advanceAndSample(1300);
    d.advanceAndSample(1300);
    d.advanceAndSample(1300); // wedge onset
    expect(d.watchdog.getStats().wedged).toBe(true);

    d.advanceAndSample(1000); // healthy sample → recovery
    const s = d.watchdog.getStats();
    expect(s.wedged).toBe(false);
    expect(s.consecutiveHighSamples).toBe(0);
    expect(s.wedgeCount).toBe(1); // count of episodes is retained
    expect(d.logs.some((l) => l.includes('recovered'))).toBe(true);

    // A second wedge is a distinct episode → count increments.
    d.advanceAndSample(1300);
    d.advanceAndSample(1300);
    d.advanceAndSample(1300);
    expect(d.watchdog.getStats().wedgeCount).toBe(2);
  });

  it('works end-to-end with vitest fake timers driving the real interval', () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    // Real setInterval (faked) + Date-based clocks. Fake time is exact, so no
    // lag is produced — this asserts the wiring: interval fires, stays healthy.
    const watchdog = new WsWatchdog({
      intervalMs: 1000,
      thresholdMs: 250,
      nowMs: () => Date.now(),
      wallClock: () => Date.now(),
      log: (m) => logs.push(m),
    });
    watchdog.start();
    vi.advanceTimersByTime(5000);
    const s = watchdog.getStats();
    expect(s.samples).toBeGreaterThanOrEqual(4);
    expect(s.wedgeCount).toBe(0);
    expect(logs).toHaveLength(0);
    watchdog.stop();
    const after = watchdog.getStats().samples;
    vi.advanceTimersByTime(5000);
    expect(watchdog.getStats().samples).toBe(after); // stop() really cleared it
  });
});
