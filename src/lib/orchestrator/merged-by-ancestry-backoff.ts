// #1498 — Per-candidate negative cache for the merged-by-ancestry sweep.
//
// A pathological lane (e.g. one whose `git patch-id --stable` diff is huge
// enough to time out) was re-checked on EVERY 30s sweep, re-spawning the same
// expensive git pipeline against a large .cortex-worktrees clone farm and
// churning the ws-server process. This adds an exponential backoff keyed by
// candidate: a detect() that THROWS (timeout / git error) parks the candidate
// for a growing window instead of retrying every cycle. A clean detect (merged
// OR honestly not-merged) clears the entry, so a lane that later merges is
// still caught promptly. Pure + injectable-clock so the logic is unit-tested
// without spawning git.

export interface BackoffEntry {
  failures: number;
  nextEligibleAt: number;
}

// First failure parks the candidate for 60s; each consecutive failure doubles
// the window up to a 10-minute cap. Worst case, a genuinely-merged pathological
// lane is reconciled up to ~10 min late instead of within 30s — an acceptable
// trade to stop the hot re-check. Healthy lanes never enter the map.
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 600_000;

export class MergedByAncestryBackoff {
  private readonly entries = new Map<string, BackoffEntry>();

  /** True when the candidate is parked and must be skipped this cycle. */
  shouldSkip(key: string, now: number): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && now < entry.nextEligibleAt;
  }

  /** Record a detect() failure; grows the backoff window exponentially. */
  recordFailure(key: string, now: number): void {
    const prior = this.entries.get(key);
    const failures = (prior?.failures ?? 0) + 1;
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
    this.entries.set(key, { failures, nextEligibleAt: now + delay });
  }

  /** Clear the candidate — a clean check succeeded (merged or not). */
  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** Drop parked entries for candidates no longer present, bounding memory. */
  prune(activeKeys: Iterable<string>): void {
    const active = new Set(activeKeys);
    for (const key of this.entries.keys()) {
      if (!active.has(key)) this.entries.delete(key);
    }
  }

  /** Test/inspection helper — number of currently parked candidates. */
  get size(): number {
    return this.entries.size;
  }
}
