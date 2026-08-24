import 'server-only';

import type Database from 'better-sqlite3';

/** The cap's window: lines produced in the last hour. */
export const BROADCAST_HOURLY_WINDOW_MS = 60 * 60_000;

export function broadcastHourlyWindowStart(now: Date): string {
  return new Date(now.getTime() - BROADCAST_HOURLY_WINDOW_MS).toISOString();
}

/** Count the capped-class commentary lines produced since `timestamp`. */
export function broadcastGeneratedLinesSince(sqlite: Database.Database, timestamp: string): number {
  const row = sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM broadcast_events
    WHERE kind = 'commentary'
      AND (
        json_extract(metadata_json, '$.director') = 1
        OR json_extract(metadata_json, '$.hourlyCapped') = 1
      )
      AND created_at >= ?
  `).get(timestamp) as { count: number };
  return row.count;
}

/**
 * Take one slot in the hourly cap and write the line, or refuse.
 *
 * The cap used to be four independent check-then-act sites across two
 * producers, with an await between each read and its write: the director's
 * commentary call, the speaker's compose. Two producers could each read 11
 * against a cap of 12, each conclude there was room, and both append — so the
 * ceiling was soft by however many producers were running, and a window with
 * `max_per_hour = 12` produced 13 lines (#1840).
 *
 * The count is re-read INSIDE the same IMMEDIATE transaction that performs the
 * insert, so no await can open between deciding and writing, and a second
 * producer — in this process or another — sees the first one's row. Every
 * producer goes through here rather than testing the count for itself.
 *
 * Returns the insert's value, or `null` when the window is full.
 */
export function claimBroadcastLineSlot<T>(
  sqlite: Database.Database,
  now: Date,
  maxPerHour: number,
  insert: () => T,
): T | null {
  if (!Number.isFinite(maxPerHour) || maxPerHour <= 0) return null;
  const windowStart = broadcastHourlyWindowStart(now);
  const claim = sqlite.transaction(() => {
    if (broadcastGeneratedLinesSince(sqlite, windowStart) >= maxPerHour) return null;
    return { value: insert() };
  });
  // IMMEDIATE, not the default deferred: the producers live in different
  // processes (the director loop in the Next server, the speaker in
  // ws-server) against one SQLite file. A deferred transaction takes a read
  // lock and upgrades on write, so both producers can still read the same
  // count and the loser gets SQLITE_BUSY rather than a fresh count. IMMEDIATE
  // takes the write lock up front, so the second claim waits and then re-reads
  // with the first one's row already committed.
  return claim.immediate()?.value ?? null;
}
