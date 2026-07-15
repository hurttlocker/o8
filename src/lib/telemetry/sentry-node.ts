import 'server-only';

/**
 * @sentry/node init for the two local Node processes — the bundled Next server
 * (installed from src/instrumentation.ts) and the ws-server (installed at its
 * entry). Crash/error reporting for the machine, tagged with the app version +
 * plan so an error spike on 0.1.X is visible in minutes.
 *
 * DORMANT unless PACKAGED + a DSN was baked (see sentry-config.ts). No DSN → this
 * never even imports @sentry/node (dynamic import), so dev / tests pay nothing.
 *
 * Crash semantics are PRESERVED: we do not add or replace process handlers here.
 * The existing `installProcessCrashCapture` (uncaughtExceptionMonitor, observe-
 * only) still writes the local JSONL sink and the process still dies exactly as
 * before; Sentry's default fatal-error integration captures + flushes + exits.
 *
 * Live kill-switch: the "Crash & error reports" toggle is re-read in beforeSend
 * (a rare path), so turning it OFF stops the wire on the very next event — well
 * inside the ~30s budget — without any client churn.
 */

import { resolveCrashReportsToggle, resolveSentryConfig, resolveSentryDsn, isPackaged } from './sentry-config';
import { scrubSentryEvent, type SentryEventLike } from './scrub';

export type NodeSurface = 'server' | 'ws';

interface SentryNodeGlobal {
  __o8SentryNodeSurfaces?: Set<string>;
}

function installedSurfaces(): Set<string> {
  const g = globalThis as unknown as SentryNodeGlobal;
  if (!g.__o8SentryNodeSurfaces) g.__o8SentryNodeSurfaces = new Set<string>();
  return g.__o8SentryNodeSurfaces;
}

/**
 * Idempotently initialize @sentry/node for `surface`. Returns true when a client
 * was initialized, false when dormant (no DSN / not packaged) or on any failure.
 * Never throws — telemetry must never block boot.
 */
export async function initSentryNode(surface: NodeSurface): Promise<boolean> {
  try {
    const surfaces = installedSurfaces();
    if (surfaces.has(surface)) return false;

    // Dormant unless a DSN was baked into a packaged build.
    const dsn = resolveSentryDsn();
    if (!isPackaged() || !dsn) return false;
    surfaces.add(surface);

    const cfg = resolveSentryConfig();
    // Dynamic import so a dormant install (the common dev/test case) never even
    // loads the SDK. Marked external in the ws-server esbuild bundle.
    const Sentry = await import('@sentry/node');

    Sentry.init({
      dsn,
      release: cfg.release,
      environment: cfg.environment,
      sendDefaultPii: false,
      // Errors only — no performance/tracing, no profiling, no replay.
      tracesSampleRate: 0,
      sampleRate: 1.0,
      beforeSend: (event) => (resolveCrashReportsToggle() ? (scrubSentryEvent(event as SentryEventLike) as typeof event | null) : null),
    });

    Sentry.setTags({
      app_version: cfg.release,
      plan: cfg.plan,
      founder: cfg.founder, // boolean only — never the operator number
      surface,
    });

    try {
      console.log(`[telemetry] Sentry (node) initialized for "${surface}"`);
    } catch {
      /* swallow */
    }
    return true;
  } catch {
    return false;
  }
}
