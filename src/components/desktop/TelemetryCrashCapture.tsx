'use client';

import { useEffect } from 'react';

/**
 * Renderer crash capture. Listens for window 'error' + 'unhandledrejection' and
 * POSTs a sanitized payload to /api/telemetry/crash, where the server stamps the
 * app version and appends it to the shared crash store. Renders nothing.
 *
 * Sends only the error message + stack — never DOM/user content. Best-effort:
 * every failure is swallowed so a telemetry hiccup can't disturb the app. Pairs
 * with src/lib/telemetry/crash-store.ts (process-level capture writes the same
 * store).
 */

const MAX_MESSAGE = 2_000;
const MAX_STACK = 8_000;

function clip(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function report(kind: 'window.error' | 'window.unhandledrejection', message: string, stack?: string) {
  try {
    fetch('/api/telemetry/crash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'renderer',
        kind,
        message: clip(message, MAX_MESSAGE) ?? '(no message)',
        stack: clip(stack, MAX_STACK),
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* swallow */
  }
}

export function TelemetryCrashCapture() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const message = event.message || (event.error instanceof Error ? event.error.message : 'Uncaught error');
      const stack = event.error instanceof Error ? event.error.stack : undefined;
      report('window.error', message, stack);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason ?? 'Unhandled rejection');
      const stack = reason instanceof Error ? reason.stack : undefined;
      report('window.unhandledrejection', message, stack);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
