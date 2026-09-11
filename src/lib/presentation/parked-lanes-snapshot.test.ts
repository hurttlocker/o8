import { describe, expect, it } from 'vitest';

import {
  PARKED_LANES_HEARTBEAT_MS,
  PARKED_LANES_RUN_ID,
  PARKED_LANES_STALE_AFTER_MS,
  parkedSnapshotIsStale,
  parkedSnapshotIsUsable,
} from './parked-lanes-snapshot';

/**
 * The stale-count bug in #2147: the dock pill kept painting a parked-lane count
 * from a previous dashboard run, because the dashboard only pushed on change and
 * the dock window outlives it. These cases pin the freshness rule that fixes it.
 */
describe('parked-lane snapshot freshness', () => {
  const now = 1_700_000_000_000;

  it('trusts a snapshot inside the expiry window', () => {
    expect(parkedSnapshotIsStale({ emittedAt: now }, now)).toBe(false);
    expect(parkedSnapshotIsStale({ emittedAt: now - PARKED_LANES_HEARTBEAT_MS }, now)).toBe(false);
    expect(parkedSnapshotIsStale({ emittedAt: now - PARKED_LANES_STALE_AFTER_MS }, now)).toBe(false);
  });

  it('expires a snapshot once the heartbeat has stopped', () => {
    expect(parkedSnapshotIsStale({ emittedAt: now - PARKED_LANES_STALE_AFTER_MS - 1 }, now)).toBe(true);
    // The shape of the original bug: an hour-old count with nothing in flight.
    expect(parkedSnapshotIsStale({ emittedAt: now - 3_600_000 }, now)).toBe(true);
  });

  it('treats an unstamped payload as stale rather than trusting it forever', () => {
    expect(parkedSnapshotIsStale({}, now)).toBe(true);
    expect(parkedSnapshotIsStale({ emittedAt: Number.NaN }, now)).toBe(true);
    expect(parkedSnapshotIsUsable({ count: 3 }, now)).toBe(false);
  });

  it('does not blank a live count over clock skew between the two windows', () => {
    expect(parkedSnapshotIsStale({ emittedAt: now + 5_000 }, now)).toBe(false);
  });

  it('survives at least two missed heartbeats before expiring', () => {
    expect(PARKED_LANES_STALE_AFTER_MS).toBeGreaterThan(PARKED_LANES_HEARTBEAT_MS * 2);
  });

  it('stamps a run id so a snapshot can be tied to the document that sent it', () => {
    expect(PARKED_LANES_RUN_ID).toMatch(/^run-[a-z0-9]+-[a-z0-9]+$/);
  });
});
