import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relativeTimeLabel } from './relative-time';
import { formatDuration } from './duration';

// Verbatim copies of the seven pre-consolidation implementations. Each new call
// site delegates to relativeTimeLabel; these assert the delegation reproduces the
// original rendered output byte-for-byte across the full delta range.

// mobile-approvals-shared.tsx (number input, seconds-based sub-minute)
function origApprovals(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// DeployStatus / IssuesPage / ActivityFeed (iso input, minutes-based, lowercase)
function origIsoLower(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// SessionPickerSheet (capitalized, clamped)
function origSession(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// repo-registry/shared.tsx (round-min-1, date fallback after 7d)
function origRepoRegistry(value: string): string {
  const timestamp = new Date(value).getTime();
  const delta = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return 'Just now';
  if (delta < hour) return `${Math.max(1, Math.round(delta / minute))}m ago`;
  if (delta < day) return `${Math.max(1, Math.round(delta / hour))}h ago`;
  if (delta < 7 * day) return `${Math.max(1, Math.round(delta / day))}d ago`;
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// DemoRunSection (seconds granularity)
function origDemoRun(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const delta = Math.max(0, Date.now() - t);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function origDurationA(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
function origDurationB(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DELTAS = [
  0, 500, 999, 1000, 30_000, 59_000, 59_999, 60_000, 60_001, 89_000, 91_000,
  MINUTE, MINUTE + 1, 30 * MINUTE, 59 * MINUTE, HOUR - 1, HOUR, HOUR + 1,
  90 * MINUTE, 23 * HOUR, DAY - 1, DAY, DAY + 1, 6 * DAY, 7 * DAY - 1, 7 * DAY,
  7 * DAY + 1, 30 * DAY, 400 * DAY,
  // future / clock-skew
  -1, -60_000, -100_000_000,
];

const NOW = Date.UTC(2026, 6, 7, 18, 30, 0);

describe('relativeTimeLabel parity with the seven original copies', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const delta of DELTAS) {
    const ts = NOW - delta;
    const iso = new Date(ts).toISOString();

    it(`matches at delta=${delta}ms`, () => {
      expect(relativeTimeLabel(ts, { subMinute: 'just-now-lower' })).toBe(origApprovals(ts));
      expect(relativeTimeLabel(new Date(iso).getTime(), { subMinute: 'just-now-lower' })).toBe(
        origIsoLower(iso),
      );
      expect(relativeTimeLabel(ts, { subMinute: 'just-now-upper' })).toBe(origSession(ts));
      expect(
        relativeTimeLabel(new Date(iso).getTime(), {
          subMinute: 'just-now-upper',
          rounding: 'round-min-1',
          overflow: 'date',
        }),
      ).toBe(origRepoRegistry(iso));
      expect(relativeTimeLabel(Date.parse(iso), { subMinute: 'seconds' })).toBe(origDemoRun(iso));
    });
  }

  it('reproduces the unguarded NaN path as "NaNd ago"', () => {
    expect(relativeTimeLabel(new Date('garbage').getTime(), { subMinute: 'just-now-lower' })).toBe(
      origIsoLower('garbage'),
    );
    expect(relativeTimeLabel(new Date('garbage').getTime(), { subMinute: 'just-now-lower' })).toBe(
      'NaNd ago',
    );
  });
});

describe('formatDuration parity', () => {
  for (const ms of [0, 1, 500, 999, 1000, 1001, 1500, 2499, 59_999, 123_456]) {
    it(`matches at ms=${ms}`, () => {
      expect(formatDuration(ms)).toBe(origDurationA(ms));
      expect(formatDuration(ms)).toBe(origDurationB(ms));
    });
  }
});
