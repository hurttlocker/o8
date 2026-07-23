/**
 * Crash telemetry store — the append-only JSONL sink shared by every crash
 * source (Next server process, ws-server process, renderer window).
 *
 * Design constraints (Rock 2):
 *   - NEVER throws. Every public function swallows its own errors — a broken
 *     telemetry write must never take down the process it is observing.
 *   - NEVER blocks the event loop on the hot path. Normal appends are async and
 *     serialized through an internal promise chain. The ONE sync path is the
 *     dying-process crash handler (uncaughtException), where an async write
 *     would not flush before the process tears down.
 *   - Bounded on disk. A size-based ring buffer keeps crashes.jsonl under ~1MB;
 *     when it would overflow we drop the OLDEST lines and keep the tail.
 *   - Contains NO user content and NO environment variables — only the app
 *     version, a source tag, the error message, and the stack.
 *
 * File: DATA_DIR/telemetry/crashes.jsonl (DATA_DIR honours O8_DATA_DIR /
 * CORTEX_IDE_DATA_DIR exactly like src/lib/db/).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export type CrashSource = string;

export type CrashKind =
  | 'uncaughtException'
  | 'unhandledRejection'
  | 'window.error'
  | 'window.unhandledrejection';

export interface CrashRecord {
  /** Epoch millis when the crash was captured. */
  ts: number;
  /** Where it happened: 'next-server' | 'ws-server' | 'renderer' | 'boot' | … */
  source: CrashSource;
  /** App version at crash time (best-effort; 'unknown' if unresolved). */
  appVersion: string;
  kind: CrashKind;
  /** Sanitized error message (truncated, no user content). */
  message: string;
  /** Sanitized stack trace (truncated). */
  stack?: string;
}

const MAX_FILE_BYTES = 1_000_000; // ~1MB ring-buffer ceiling.
const KEEP_TAIL_BYTES = 500_000; // On overflow, retain roughly the last half.
const MAX_MESSAGE_CHARS = 2_000;
const MAX_STACK_CHARS = 8_000;

function dataDir(): string {
  return (
    getDataDir()
  );
}

export function telemetryDir(): string {
  return path.join(dataDir(), 'telemetry');
}

export function crashLogPath(): string {
  return path.join(telemetryDir(), 'crashes.jsonl');
}

// ── App version (best-effort, cached) ──

let cachedVersion: string | null = null;

export function resolveAppVersion(): string {
  if (cachedVersion) return cachedVersion;
  const fromEnv = process.env.O8_APP_VERSION?.trim();
  if (fromEnv) {
    cachedVersion = fromEnv;
    return cachedVersion;
  }
  // Walk up from cwd looking for a package.json with a version. In dev the cwd
  // is the repo root; in the packaged standalone build a package.json is copied
  // alongside the server entry (scripts/tauri-export.mjs), so this resolves in
  // both worlds without hardcoding a path.
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    try {
      const pkgPath = path.join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
        if (typeof parsed.version === 'string' && parsed.version.trim()) {
          cachedVersion = parsed.version.trim();
          return cachedVersion;
        }
      }
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedVersion = 'unknown';
  return cachedVersion;
}

// ── Sanitize ──

function truncate(value: unknown, max: number): string {
  if (typeof value !== 'string') {
    if (value == null) return '';
    try {
      value = String(value);
    } catch {
      return '';
    }
  }
  const str = value as string;
  return str.length > max ? `${str.slice(0, max)}…[truncated]` : str;
}

/**
 * Build a fully-sanitized record. Message + stack are truncated; nothing else
 * from the caller is trusted onto disk. JSON.stringify escapes any embedded
 * newlines so each record stays a single JSONL line.
 */
export function buildCrashRecord(input: {
  source: CrashSource;
  kind: CrashKind;
  message?: unknown;
  stack?: unknown;
  ts?: number;
  appVersion?: string;
}): CrashRecord {
  const record: CrashRecord = {
    ts: typeof input.ts === 'number' && Number.isFinite(input.ts) ? input.ts : Date.now(),
    source: truncate(input.source || 'unknown', 64),
    appVersion: input.appVersion?.trim() || resolveAppVersion(),
    kind: input.kind,
    message: truncate(input.message, MAX_MESSAGE_CHARS) || '(no message)',
  };
  const stack = truncate(input.stack, MAX_STACK_CHARS);
  if (stack) record.stack = stack;
  return record;
}

function serialize(record: CrashRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Given the existing file contents and a target byte budget, drop whole lines
 * from the FRONT (oldest) until the retained tail fits. Pure — unit-testable.
 */
export function computeRetainedTail(existing: string, keepBytes: number): string {
  if (Buffer.byteLength(existing, 'utf8') <= keepBytes) return existing;
  const lines = existing.split('\n');
  // Drop from the front until the joined tail is under budget.
  while (lines.length > 1 && Buffer.byteLength(lines.join('\n'), 'utf8') > keepBytes) {
    lines.shift();
  }
  return lines.join('\n');
}

// ── Async append (hot path, serialized) ──

let writeChain: Promise<void> = Promise.resolve();

async function doAsyncAppend(line: string): Promise<void> {
  const dir = telemetryDir();
  const file = crashLogPath();
  await mkdir(dir, { recursive: true });
  try {
    const info = await stat(file);
    if (info.size + Buffer.byteLength(line, 'utf8') > MAX_FILE_BYTES) {
      const existing = await readFile(file, 'utf8');
      const tail = computeRetainedTail(existing, KEEP_TAIL_BYTES);
      const tmp = `${file}.tmp`;
      await writeFile(tmp, tail, 'utf8');
      await rename(tmp, file);
    }
  } catch {
    // ENOENT (first write) or any stat/rotate failure — just append below.
  }
  await appendFile(file, line, 'utf8');
}

/**
 * Append a crash record without blocking the caller. Fire-and-forget: the
 * returned promise resolves when the write lands but callers may ignore it.
 * Appends are serialized so concurrent writers cannot interleave or corrupt a
 * rotation. Never rejects.
 */
export function appendCrashLine(record: CrashRecord): Promise<void> {
  const line = serialize(record);
  writeChain = writeChain.then(() => doAsyncAppend(line)).catch((err) => {
    try {
      console.error('[telemetry] async crash append failed:', err instanceof Error ? err.message : err);
    } catch {
      /* swallow */
    }
  });
  return writeChain;
}

// ── Sync append (dying-process path only) ──

/**
 * Synchronous best-effort append. Used ONLY from the uncaughtException path,
 * where the process is about to exit and an async write would never flush.
 * Never throws.
 */
export function appendCrashLineSync(record: CrashRecord): void {
  try {
    const dir = telemetryDir();
    const file = crashLogPath();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = serialize(record);
    try {
      if (existsSync(file)) {
        const info = statSync(file);
        if (info.size + Buffer.byteLength(line, 'utf8') > MAX_FILE_BYTES) {
          const existing = readFileSync(file, 'utf8');
          const tail = computeRetainedTail(existing, KEEP_TAIL_BYTES);
          const tmp = `${file}.tmp`;
          writeFileSync(tmp, tail, 'utf8');
          renameSync(tmp, file);
        }
      }
    } catch {
      // rotation is best-effort; still append below.
    }
    appendFileSync(file, line, 'utf8');
  } catch (err) {
    try {
      console.error('[telemetry] sync crash append failed:', err instanceof Error ? err.message : err);
    } catch {
      /* swallow */
    }
  }
}

// ── Read (uploader) ──

/**
 * Read all persisted crash records. Malformed lines are skipped. Never throws;
 * returns [] when the file is absent or unreadable.
 */
export function readCrashRecords(): CrashRecord[] {
  try {
    const file = crashLogPath();
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, 'utf8');
    const out: CrashRecord[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as CrashRecord;
        if (parsed && typeof parsed.ts === 'number' && typeof parsed.message === 'string') {
          out.push(parsed);
        }
      } catch {
        // skip malformed line
      }
    }
    return out;
  } catch {
    return [];
  }
}
