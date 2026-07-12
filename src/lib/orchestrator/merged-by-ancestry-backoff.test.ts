import { describe, it, expect } from 'vitest';

import { MergedByAncestryBackoff } from './merged-by-ancestry-backoff';

describe('MergedByAncestryBackoff', () => {
  it('does not skip a candidate that has never failed', () => {
    const backoff = new MergedByAncestryBackoff();
    expect(backoff.shouldSkip('lane-a', 0)).toBe(false);
  });

  it('parks a candidate for 60s after the first failure', () => {
    const backoff = new MergedByAncestryBackoff();
    backoff.recordFailure('lane-a', 1_000);
    expect(backoff.shouldSkip('lane-a', 1_000)).toBe(true);
    expect(backoff.shouldSkip('lane-a', 1_000 + 59_999)).toBe(true);
    // Window opens at exactly now + 60s.
    expect(backoff.shouldSkip('lane-a', 1_000 + 60_000)).toBe(false);
  });

  it('doubles the backoff window on each consecutive failure', () => {
    const backoff = new MergedByAncestryBackoff();
    backoff.recordFailure('lane-a', 0); // 60s
    backoff.recordFailure('lane-a', 0); // 120s
    expect(backoff.shouldSkip('lane-a', 119_999)).toBe(true);
    expect(backoff.shouldSkip('lane-a', 120_000)).toBe(false);
    backoff.recordFailure('lane-a', 0); // 240s
    expect(backoff.shouldSkip('lane-a', 239_999)).toBe(true);
    expect(backoff.shouldSkip('lane-a', 240_000)).toBe(false);
  });

  it('caps the backoff window at 10 minutes', () => {
    const backoff = new MergedByAncestryBackoff();
    for (let i = 0; i < 20; i += 1) backoff.recordFailure('lane-a', 0);
    expect(backoff.shouldSkip('lane-a', 599_999)).toBe(true);
    expect(backoff.shouldSkip('lane-a', 600_000)).toBe(false);
  });

  it('clears the entry on a successful check so a later merge is caught promptly', () => {
    const backoff = new MergedByAncestryBackoff();
    backoff.recordFailure('lane-a', 0);
    expect(backoff.size).toBe(1);
    backoff.recordSuccess('lane-a');
    expect(backoff.size).toBe(0);
    expect(backoff.shouldSkip('lane-a', 1)).toBe(false);
  });

  it('resets the failure count after a success (backoff starts over at 60s)', () => {
    const backoff = new MergedByAncestryBackoff();
    backoff.recordFailure('lane-a', 0);
    backoff.recordFailure('lane-a', 0); // now at 120s
    backoff.recordSuccess('lane-a');
    backoff.recordFailure('lane-a', 0); // fresh — back to 60s
    expect(backoff.shouldSkip('lane-a', 59_999)).toBe(true);
    expect(backoff.shouldSkip('lane-a', 60_000)).toBe(false);
  });

  it('prunes entries for candidates no longer present', () => {
    const backoff = new MergedByAncestryBackoff();
    backoff.recordFailure('lane-a', 0);
    backoff.recordFailure('lane-b', 0);
    expect(backoff.size).toBe(2);
    backoff.prune(['lane-a']);
    expect(backoff.size).toBe(1);
    expect(backoff.shouldSkip('lane-a', 0)).toBe(true);
    expect(backoff.shouldSkip('lane-b', 0)).toBe(false);
  });

  it('tracks candidates independently', () => {
    const backoff = new MergedByAncestryBackoff();
    backoff.recordFailure('lane-a', 0);
    expect(backoff.shouldSkip('lane-a', 30_000)).toBe(true);
    expect(backoff.shouldSkip('lane-b', 30_000)).toBe(false);
  });
});
