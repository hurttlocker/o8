// Single source of truth for the "n minutes ago" labels that had drifted into
// seven near-identical copies across the mobile and desktop surfaces. The copies
// disagreed on details that ARE user-visible, so this util is parameterized to
// reproduce each one exactly rather than unify them — preservation over
// cleanliness. Callers keep their own input parsing and null/invalid guards
// (those returned site-specific strings like 'Never' / 'Unknown' / the raw
// input) and pass a finite millisecond timestamp plus the options below.

export interface RelativeTimeOptions {
  /**
   * Sub-minute (delta < 60s) rendering. The copies drifted three ways:
   *   'just-now-lower'  → 'just now'   (mobile-approvals timeAgo, DeployStatus,
   *                                     IssuesPage, ActivityFeed)
   *   'just-now-upper'  → 'Just now'   (SessionPickerSheet, repo-registry shared)
   *   'seconds'         → '<n>s ago'   (DemoRunSection formatRelative — the only
   *                                     copy that showed seconds granularity)
   */
  subMinute: 'just-now-lower' | 'just-now-upper' | 'seconds';
  /**
   * Magnitude rounding. Six copies used Math.floor; repo-registry's shared copy
   * used Math.max(1, Math.round(...)) so it never showed a bare '0m ago'.
   * Defaults to 'floor'.
   */
  rounding?: 'floor' | 'round-min-1';
  /**
   * Behavior past 7 days. Six copies kept counting days forever ('45d ago');
   * repo-registry's copy switched to a localized 'Mon D' date. Defaults to
   * 'days'.
   */
  overflow?: 'days' | 'date';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function magnitude(delta: number, unit: number, rounding: 'floor' | 'round-min-1'): number {
  return rounding === 'floor' ? Math.floor(delta / unit) : Math.max(1, Math.round(delta / unit));
}

/**
 * Format the elapsed time since `timestampMs` as a relative label. `timestampMs`
 * may be NaN (unparsed input) — the floor/'days' path then yields 'NaNd ago',
 * matching the copies that had no guard; guard at the call site if you need a
 * friendlier string.
 */
export function relativeTimeLabel(timestampMs: number, options: RelativeTimeOptions): string {
  const rounding = options.rounding ?? 'floor';
  // Clamp future timestamps to 0 — every copy either clamped explicitly or, via
  // the sub-minute branch, rendered a negative delta as "just now" regardless.
  const delta = Math.max(0, Date.now() - timestampMs);

  if (delta < MINUTE) {
    if (options.subMinute === 'seconds') return `${Math.floor(delta / 1000)}s ago`;
    return options.subMinute === 'just-now-upper' ? 'Just now' : 'just now';
  }
  if (delta < HOUR) return `${magnitude(delta, MINUTE, rounding)}m ago`;
  if (delta < DAY) return `${magnitude(delta, HOUR, rounding)}h ago`;
  if (options.overflow === 'date' && delta >= 7 * DAY) {
    return new Date(timestampMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return `${magnitude(delta, DAY, rounding)}d ago`;
}
