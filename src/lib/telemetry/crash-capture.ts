/**
 * Process-level crash capture. Registers observers for uncaught exceptions and
 * unhandled promise rejections that persist a sanitized JSON line to the crash
 * store (src/lib/telemetry/crash-store.ts).
 *
 * Wiring:
 *   - Next server process — installed from src/instrumentation.ts register().
 *   - ws-server process   — the ws-server owner adds ONE line at its entry:
 *       import { installProcessCrashCapture } from '@/lib/telemetry/crash-capture';
 *       installProcessCrashCapture('ws-server');
 *   - Packaged early boot  — the generated out/server/server.js wrapper installs
 *       a minimal inline guard before Next boots (scripts/tauri-export.mjs).
 *
 * We use `uncaughtExceptionMonitor` (not a plain `uncaughtException` listener)
 * so we OBSERVE the crash without suppressing Node's default action — the
 * process still prints + exits exactly as it would have. The monitor runs
 * synchronously before teardown, so we write synchronously there (an async
 * write would never flush before the process dies). Unhandled rejections do not
 * kill the process the same way, so those are written on the async hot path.
 */

import {
  appendCrashLine,
  appendCrashLineSync,
  buildCrashRecord,
  type CrashSource,
} from './crash-store';

interface CaptureGlobal {
  __o8TelemetryCaptureSources?: Set<string>;
}

function installedSources(): Set<string> {
  const g = globalThis as unknown as CaptureGlobal;
  if (!g.__o8TelemetryCaptureSources) g.__o8TelemetryCaptureSources = new Set<string>();
  return g.__o8TelemetryCaptureSources;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || 'Error';
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function stackOf(err: unknown): string | undefined {
  return err instanceof Error && typeof err.stack === 'string' ? err.stack : undefined;
}

/**
 * Idempotently install crash observers for `source`. Safe to call more than once
 * (dev HMR, double registration) — a per-source guard on globalThis prevents
 * duplicate listeners. Never throws.
 */
export function installProcessCrashCapture(source: CrashSource): void {
  try {
    const sources = installedSources();
    if (sources.has(source)) return;
    sources.add(source);

    process.on('uncaughtExceptionMonitor', (err) => {
      try {
        appendCrashLineSync(
          buildCrashRecord({
            source,
            kind: 'uncaughtException',
            message: messageOf(err),
            stack: stackOf(err),
          }),
        );
      } catch {
        /* observer must never interfere with the crash */
      }
    });

    process.on('unhandledRejection', (reason) => {
      try {
        void appendCrashLine(
          buildCrashRecord({
            source,
            kind: 'unhandledRejection',
            message: messageOf(reason),
            stack: stackOf(reason),
          }),
        );
      } catch {
        /* fire-and-forget */
      }
    });

    try {
      console.log(`[telemetry] crash capture installed for "${source}"`);
    } catch {
      /* swallow */
    }
  } catch {
    // Installing telemetry must never throw into the caller's boot path.
  }
}
