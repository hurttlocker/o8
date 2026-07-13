import 'server-only';

/**
 * Crash digest for the bug-report intake.
 *
 * A user report says "the diff panel went blank"; the crash log says a TypeError
 * fired in the renderer 90 seconds earlier. Those two facts live on the same
 * machine and never met. This joins them: every report carries the crashes that
 * preceded it, so triage starts from a stack trace instead of a guess.
 *
 * Sentry (packaged builds only) already receives these same crashes — this path
 * exists because it ALSO works in dev/dev-bridge, where Sentry is deliberately
 * dormant, and because it puts the trace in front of whoever reads the report.
 *
 * Carries only what crash-store.ts persists: version, source, kind, message,
 * stack. No user content, no env vars.
 */

import { readCrashRecords, type CrashRecord } from './crash-store';

/** Only crashes from this window before the report are worth attaching. */
export const CRASH_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Newest-first cap — a crash-looping process must not blow the upload. */
export const MAX_DIGEST_RECORDS = 5;
/** Hard ceiling on the rendered attachment. */
export const MAX_DIGEST_BYTES = 64 * 1024;

export interface CrashDigest {
  /** Crashes inside the window (before the cap). */
  count: number;
  /** The newest ones, newest first, capped at MAX_DIGEST_RECORDS. */
  records: CrashRecord[];
  /** One-line summary for a Discord embed field. '' when there are none. */
  summary: string;
  /** Rendered attachment body. '' when there are none. */
  text: string;
}

const EMPTY: CrashDigest = { count: 0, records: [], summary: '', text: '' };

/**
 * Select the crashes inside the window, newest first, capped. Pure — the I/O
 * lives in `collectCrashDigest`, so the windowing/cap/render logic is testable
 * without touching disk.
 */
export function buildCrashDigest(all: CrashRecord[], now: number): CrashDigest {
  const cutoff = now - CRASH_WINDOW_MS;
  const inWindow = all
    .filter((r) => typeof r.ts === 'number' && r.ts >= cutoff && r.ts <= now)
    .sort((a, b) => b.ts - a.ts);

  if (inWindow.length === 0) return EMPTY;

  const records = inWindow.slice(0, MAX_DIGEST_RECORDS);
  const newest = records[0];
  const dropped = inWindow.length - records.length;

  const summary = [
    `${inWindow.length} in the last 24h`,
    `latest: ${newest.kind} in ${newest.source} — ${firstLine(newest.message)}`,
  ].join(' · ');

  const header = [
    `${inWindow.length} crash${inWindow.length === 1 ? '' : 'es'} in the 24h before this report.`,
    dropped > 0 ? `Showing the ${records.length} most recent (${dropped} older omitted).` : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');

  const body = records.map(renderRecord).join('\n\n');
  return { count: inWindow.length, records, summary, text: clamp(`${header}\n${body}\n`) };
}

/** Read the on-disk crash log and digest it. Never throws. */
export function collectCrashDigest(now: number = Date.now()): CrashDigest {
  try {
    return buildCrashDigest(readCrashRecords(), now);
  } catch {
    return EMPTY;
  }
}

function firstLine(message: string): string {
  const line = (message || '').split('\n')[0].trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line || '(no message)';
}

function renderRecord(record: CrashRecord): string {
  const when = new Date(record.ts).toISOString();
  const lines = [
    `── ${when} · ${record.source} · ${record.kind} · v${record.appVersion}`,
    record.message,
  ];
  if (record.stack) lines.push('', record.stack);
  return lines.join('\n');
}

function clamp(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_DIGEST_BYTES) return text;
  // Keep the head — the newest crash is the one that matters.
  return `${Buffer.from(text, 'utf8').subarray(0, MAX_DIGEST_BYTES - 32).toString('utf8')}\n…[truncated]\n`;
}
