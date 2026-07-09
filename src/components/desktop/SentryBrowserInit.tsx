'use client';

import { useEffect } from 'react';

import { initSentryBrowser } from '@/lib/telemetry/sentry-browser';

/**
 * Mounts the webview Sentry client (dormant unless a DSN was baked into a
 * packaged build). Renders nothing. Sibling of TelemetryCrashCapture — the
 * local JSONL renderer sink — both live at the desktop dashboard level.
 */
export function SentryBrowserInit() {
  useEffect(() => {
    void initSentryBrowser();
  }, []);
  return null;
}
