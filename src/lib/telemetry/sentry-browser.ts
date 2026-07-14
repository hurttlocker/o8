/**
 * @sentry/browser init for the desktop webview (the Next shell inside Tauri).
 *
 * DORMANT unless the server hands back a DSN — it only does so in a packaged
 * build that had one baked (`/api/telemetry/config`). No DSN → we never import
 * the SDK, never poll, never touch the network. Dev / dev-bridge stay silent.
 *
 * Errors only: the @sentry/browser default integrations capture window.onerror +
 * unhandledrejection and nothing else here — no BrowserTracing, no Replay, no
 * profiling. beforeSend scrubs home paths, strips URL query strings, and drops
 * any breadcrumb carrying a file path. sendDefaultPii is false; no user/email.
 *
 * Live kill-switch: the "Crash & error reports" toggle is polled every ~30s, so
 * turning it OFF stops the wire within the budget. (The local JSONL renderer
 * capture — TelemetryCrashCapture — is independent and unaffected.)
 */

import { scrubSentryEvent, type SentryEventLike } from './scrub';

interface TelemetryConfig {
  dsn: string;
  enabled: boolean;
  release: string;
  environment: string;
  plan: string;
  founder: boolean;
}

let started = false;
let enabled = true;
const POLL_MS = 30_000;

async function fetchConfig(): Promise<TelemetryConfig | null> {
  try {
    const res = await fetch('/api/telemetry/config', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<TelemetryConfig>;
    if (!data || typeof data.dsn !== 'string') return null;
    return {
      dsn: data.dsn,
      enabled: data.enabled !== false,
      release: typeof data.release === 'string' ? data.release : 'unknown',
      environment: typeof data.environment === 'string' ? data.environment : 'production',
      plan: typeof data.plan === 'string' ? data.plan : 'free',
      founder: data.founder === true,
    };
  } catch {
    return null;
  }
}

export async function initSentryBrowser(): Promise<void> {
  try {
    if (started || typeof window === 'undefined') return;
    const cfg = await fetchConfig();
    if (!cfg || !cfg.dsn) return; // dormant — no DSN, no SDK, no polling
    started = true;
    enabled = cfg.enabled;

    const Sentry = await import('@sentry/browser');
    Sentry.init({
      dsn: cfg.dsn,
      release: cfg.release,
      environment: cfg.environment,
      sendDefaultPii: false,
      // Errors only — default integrations capture window errors; no tracing.
      tracesSampleRate: 0,
      sampleRate: 1.0,
      beforeSend: (event) =>
        enabled
          ? (scrubSentryEvent(event as SentryEventLike, { dropBreadcrumbsWithPaths: true }) as typeof event | null)
          : null,
    });
    Sentry.setTags({
      app_version: cfg.release,
      plan: cfg.plan,
      founder: cfg.founder, // boolean only — never the operator number
      surface: 'webview',
    });

    // Live kill-switch + tag refresh (plan can change on upgrade).
    window.setInterval(() => {
      void (async () => {
        const next = await fetchConfig();
        if (!next) return;
        enabled = next.enabled;
        try {
          Sentry.setTags({ plan: next.plan, founder: next.founder });
        } catch {
          /* swallow */
        }
      })();
    }, POLL_MS);
  } catch {
    /* telemetry must never disturb the app */
  }
}
