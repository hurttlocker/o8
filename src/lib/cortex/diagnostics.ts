/**
 * #749 — Substrate eval gate (read-only instrumentation).
 *
 * Wraps recall-path queries with `performance.now()` timing and pushes each
 * sample into an in-memory ring buffer. The buffer is hydrated from disk on
 * first import and lazily flushed back on every Nth append, plus on demand
 * via `flushTimingBuffer()`.
 *
 * No code changes to the substrate itself — this module is pure read-only
 * observability so we can answer "is SQLite still fine, or is it time to
 * evaluate a swap?" without guessing.
 *
 * Storage: `<dataDir>/recall-metrics.json` — buffer is FIFO-evicted at
 * `MAX_SAMPLES` so the file stays small (< 200 KB) regardless of uptime.
 *
 * No-throw policy: timing must never affect recall behaviour. Every helper
 * swallows IO errors and logs with the `[recall-metrics]` prefix.
 */

import 'server-only';

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';

/** Max number of samples kept in the ring buffer. FIFO eviction beyond this. */
export const MAX_SAMPLES = 1000;

/**
 * Persist to disk after every N appends. Trades a tiny bit of crash-safety
 * (the last <10 samples may be lost on a hard kill) for not slamming the FS
 * on every recall query.
 */
const FLUSH_EVERY_N_SAMPLES = 10;

const METRICS_FILE = 'recall-metrics.json';

/** A single timing sample. Shape kept narrow on purpose — easy to extend later. */
export interface RecallTimingSample {
  /** Logical label, e.g. `recall.recent-outcomes`. */
  label: string;
  /** Wall-clock duration in milliseconds, post `performance.now()`. */
  durationMs: number;
  /** Unix epoch ms when the sample was recorded. */
  timestamp: number;
  /** True when the wrapped fn threw — durationMs still represents wall time. */
  errored?: boolean;
}

interface PersistedFile {
  version: 1;
  samples: RecallTimingSample[];
}

// ── module-local state ────────────────────────────────────────────────────

let _buffer: RecallTimingSample[] | null = null;
let _appendsSinceFlush = 0;
let _lastFileFailure = 0;

function metricsFilePath(): string {
  return join(getDataDir(), METRICS_FILE);
}

function loadFromDisk(): RecallTimingSample[] {
  const path = metricsFilePath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedFile>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.samples)) {
      return [];
    }
    // Defensive — strip malformed entries but keep the rest.
    const out: RecallTimingSample[] = [];
    for (const entry of parsed.samples) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Partial<RecallTimingSample>;
      if (
        typeof e.label !== 'string' ||
        typeof e.durationMs !== 'number' ||
        typeof e.timestamp !== 'number'
      ) continue;
      if (!Number.isFinite(e.durationMs) || !Number.isFinite(e.timestamp)) continue;
      out.push({
        label: e.label,
        durationMs: e.durationMs,
        timestamp: e.timestamp,
        errored: e.errored === true ? true : undefined,
      });
    }
    // Hard cap on hydrate too — disk file may be older than the current ceiling.
    return out.slice(-MAX_SAMPLES);
  } catch (err) {
    console.warn('[recall-metrics] Failed to hydrate buffer:', err instanceof Error ? err.message : err);
    return [];
  }
}

function ensureBuffer(): RecallTimingSample[] {
  if (_buffer === null) {
    _buffer = loadFromDisk();
  }
  return _buffer;
}

function flushToDisk(buffer: RecallTimingSample[]): void {
  // Backoff after a failure — once /min, not on every append.
  const now = Date.now();
  if (_lastFileFailure > 0 && now - _lastFileFailure < 60_000) return;

  const path = metricsFilePath();
  const tmp = `${path}.tmp-${process.pid}`;
  const payload: PersistedFile = { version: 1, samples: buffer };
  try {
    writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
    renameSync(tmp, path);
    _lastFileFailure = 0;
  } catch (err) {
    _lastFileFailure = now;
    console.warn('[recall-metrics] flush failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Append a sample. Drops oldest entries past MAX_SAMPLES (FIFO).
 *
 * The same logical operation can append multiple samples — each call records
 * a single observation. Lazy disk flush every N appends.
 */
export function recordTiming(sample: RecallTimingSample): void {
  const buf = ensureBuffer();
  buf.push(sample);
  if (buf.length > MAX_SAMPLES) {
    // FIFO eviction — drop the oldest entries.
    buf.splice(0, buf.length - MAX_SAMPLES);
  }
  _appendsSinceFlush += 1;
  if (_appendsSinceFlush >= FLUSH_EVERY_N_SAMPLES) {
    _appendsSinceFlush = 0;
    flushToDisk(buf);
  }
}

/**
 * Force a flush to disk. Useful for the API endpoint so the buffer caller
 * sees fresh-on-disk data, and during tests.
 */
export function flushTimingBuffer(): void {
  const buf = ensureBuffer();
  _appendsSinceFlush = 0;
  flushToDisk(buf);
}

/**
 * Read-only view of the current buffer. Returns a defensive copy so callers
 * can sort / filter without mutating module state.
 */
export function readTimingBuffer(): RecallTimingSample[] {
  return [...ensureBuffer()];
}

/** Reset the in-memory buffer + clear the on-disk file. Test-only. */
export function __resetTimingBuffer(): void {
  _buffer = [];
  _appendsSinceFlush = 0;
  _lastFileFailure = 0;
  try {
    flushToDisk([]);
  } catch {
    // ignore — best-effort cleanup
  }
}

// ── timing wrappers ───────────────────────────────────────────────────────

/**
 * Wrap an async function with `performance.now()` timing. Records exactly
 * one sample per call (success or throw). Re-throws the original error so
 * call sites preserve their existing behaviour — instrumentation must not
 * change the recall contract.
 */
export async function withTiming<T>(label: string, fn: () => PromiseLike<T>): Promise<T> {
  const started = performance.now();
  let errored = false;
  try {
    return await fn();
  } catch (err) {
    errored = true;
    throw err;
  } finally {
    const durationMs = Math.max(0, performance.now() - started);
    recordTiming({
      label,
      durationMs,
      timestamp: Date.now(),
      errored: errored ? true : undefined,
    });
    if (durationMs > 200) {
      console.log(`[recall-metrics] ${label} ${durationMs.toFixed(1)}ms${errored ? ' (errored)' : ''}`);
    }
  }
}

/**
 * Sync variant for call sites that aren't promise-shaped (the proposer's
 * SQLite read happens inside a synchronous prepare/.all loop). Same recording
 * semantics as `withTiming`.
 */
export function withTimingSync<T>(label: string, fn: () => T): T {
  const started = performance.now();
  let errored = false;
  try {
    return fn();
  } catch (err) {
    errored = true;
    throw err;
  } finally {
    const durationMs = Math.max(0, performance.now() - started);
    recordTiming({
      label,
      durationMs,
      timestamp: Date.now(),
      errored: errored ? true : undefined,
    });
    if (durationMs > 200) {
      console.log(`[recall-metrics] ${label} ${durationMs.toFixed(1)}ms${errored ? ' (errored)' : ''}`);
    }
  }
}

// ── percentile helpers ────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  // Nearest-rank — small dataset, no need for linear interpolation.
  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, rank)]!;
}

export interface RecallTimingSummary {
  totalSamples: number;
  /** Samples with timestamp newer than `windowMs` ago. */
  windowedSamples: number;
  windowMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  errorCount: number;
  /** Per-label breakdown across the windowed samples. */
  byLabel: Array<{
    label: string;
    samples: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  }>;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Compute aggregate stats over the buffer. `windowMs` filters to recent
 * samples only — defaults to the last 24h, which is what the Diagnostics
 * tab surfaces. Threshold doc references the 7-day signal — callers can
 * pass a wider window for that lookup.
 */
export function summarizeTimings(windowMs = DEFAULT_WINDOW_MS): RecallTimingSummary {
  const all = ensureBuffer();
  const cutoff = Date.now() - Math.max(0, windowMs);
  const windowed = windowMs > 0
    ? all.filter((s) => s.timestamp >= cutoff)
    : all;

  if (windowed.length === 0) {
    return {
      totalSamples: all.length,
      windowedSamples: 0,
      windowMs,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      errorCount: 0,
      byLabel: [],
    };
  }

  const allDurations = windowed.map((s) => s.durationMs).sort((a, b) => a - b);
  const errorCount = windowed.reduce((n, s) => n + (s.errored ? 1 : 0), 0);

  const labelGroups = new Map<string, number[]>();
  for (const sample of windowed) {
    const arr = labelGroups.get(sample.label);
    if (arr) arr.push(sample.durationMs);
    else labelGroups.set(sample.label, [sample.durationMs]);
  }

  const byLabel = Array.from(labelGroups.entries())
    .map(([label, raw]) => {
      const sorted = [...raw].sort((a, b) => a - b);
      return {
        label,
        samples: sorted.length,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        p99Ms: percentile(sorted, 99),
      };
    })
    .sort((a, b) => b.samples - a.samples);

  return {
    totalSamples: all.length,
    windowedSamples: windowed.length,
    windowMs,
    p50Ms: percentile(allDurations, 50),
    p95Ms: percentile(allDurations, 95),
    p99Ms: percentile(allDurations, 99),
    maxMs: allDurations[allDurations.length - 1] ?? 0,
    errorCount,
    byLabel,
  };
}
