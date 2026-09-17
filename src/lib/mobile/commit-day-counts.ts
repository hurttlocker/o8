import 'server-only';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MobileCommitDayCounts } from '@/lib/mobile/types';

const execFileAsync = promisify(execFile);

/** Days before today covered by the window; the window holds this many days plus today. */
export const COMMIT_DAY_WINDOW_PAST_DAYS = 7;
/** Real-world UTC offsets span -12:00 to +14:00. */
const MAX_UTC_OFFSET_MINUTES = 14 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CommitDayWindow {
  utcOffsetMinutes: number;
  /** Local calendar dates, oldest first, ending with today. */
  dates: string[];
  /** Epoch ms of local midnight on the first date. */
  startMs: number;
}

/**
 * Parse the `utcOffsetMinutes` query param (minutes east of UTC; a JS client
 * sends `-new Date().getTimezoneOffset()`). Missing or invalid values fall back
 * to UTC; the applied offset is echoed in the response.
 */
export function parseUtcOffsetMinutes(raw: string | null): number {
  if (raw === null || raw.trim() === '') return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || Math.abs(value) > MAX_UTC_OFFSET_MINUTES) return 0;
  return value;
}

function localDateKey(epochMs: number, utcOffsetMinutes: number): string {
  return new Date(epochMs + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function buildCommitDayWindow(nowMs: number, utcOffsetMinutes: number): CommitDayWindow {
  const today = localDateKey(nowMs, utcOffsetMinutes);
  const todayMidnightLocalAsUtc = Date.parse(`${today}T00:00:00.000Z`);
  const dates: string[] = [];
  for (let back = COMMIT_DAY_WINDOW_PAST_DAYS; back >= 0; back -= 1) {
    dates.push(new Date(todayMidnightLocalAsUtc - back * DAY_MS).toISOString().slice(0, 10));
  }
  const startMs = todayMidnightLocalAsUtc - COMMIT_DAY_WINDOW_PAST_DAYS * DAY_MS
    - utcOffsetMinutes * 60_000;
  return { utcOffsetMinutes, dates, startMs };
}

/**
 * Committer timestamps (epoch ms) of every commit reachable from any local ref
 * since the window start. Uncapped by design: this feeds counts, not receipts.
 * Returns [] on any git failure.
 */
export async function collectRepoCommitTimes(
  localPath: string,
  window: CommitDayWindow,
): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        '-C',
        localPath,
        'log',
        '--all',
        `--since=${new Date(window.startMs).toISOString()}`,
        '--format=%cI',
      ],
      {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' },
      },
    );
    return stdout
      .split('\n')
      .map((line) => Date.parse(line.trim()))
      .filter((timestamp) => Number.isFinite(timestamp));
  } catch {
    return [];
  }
}

/** Bucket commit times into every window day; days without commits report 0. */
export function bucketCommitDays(
  window: CommitDayWindow,
  commitTimes: Iterable<number>,
): MobileCommitDayCounts {
  const counts = new Map(window.dates.map((date) => [date, 0]));
  for (const timestamp of commitTimes) {
    if (timestamp < window.startMs) continue;
    const key = localDateKey(timestamp, window.utcOffsetMinutes);
    const current = counts.get(key);
    if (current !== undefined) counts.set(key, current + 1);
  }
  return {
    utcOffsetMinutes: window.utcOffsetMinutes,
    days: window.dates.map((date) => ({ date, count: counts.get(date) ?? 0 })),
  };
}
