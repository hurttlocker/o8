'use client';

/**
 * track() — coarse client-side product telemetry (analytics epic #1249).
 *
 * Fires a named event (plus a small props bag) to the desktop forwarder
 * /api/panel/telemetry, which attaches this install's account token and relays
 * it to the license server. Fire-and-forget — NEVER blocks, NEVER throws, and
 * NEVER carries content (event names + coarse counts/flags/ids only).
 *
 * Opt-out: set localStorage 'o8:telemetry-opt-out' = '1' and nothing is sent.
 */

const OPT_OUT_KEY = 'o8:telemetry-opt-out';

export function isTelemetryOptedOut(): boolean {
  try {
    return localStorage.getItem(OPT_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setTelemetryOptOut(optedOut: boolean): void {
  try {
    if (optedOut) localStorage.setItem(OPT_OUT_KEY, '1');
    else localStorage.removeItem(OPT_OUT_KEY);
  } catch {
    // ignore — non-critical preference
  }
}

export function track(event: string, props?: Record<string, unknown>): void {
  try {
    if (typeof window === 'undefined') return;
    if (isTelemetryOptedOut()) return;
    void fetch('/api/panel/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, ...(props ? { props } : {}) }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Telemetry must never affect the app.
  }
}
