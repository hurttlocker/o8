/**
 * Freshness contract for the overlay status pill's parked-lane count (#2147).
 *
 * ROOT CAUSE of the stale count. The dock pill is a SEPARATE webview from the
 * dashboard. The dashboard pushes `o8:parked-lanes-status` only when its
 * `parkedLanes` array changes, and the dock keeps the last value it received in
 * React state. Those two facts combine badly, because the dock window outlives
 * the main window: it is created at boot and never torn down, while `main`
 * reloads (hot reload, navigation, a crashed render, quit-to-tray). After a main
 * reload the dashboard's first emit only happens once its lane state changes
 * again — so until then the pill keeps painting a count from the PREVIOUS run,
 * with nothing currently in flight. There was no liveness signal at all: the
 * pill could not distinguish "3 lanes are parked" from "3 lanes were parked
 * before you reloaded".
 *
 * The fix is a heartbeat plus an expiry. The dashboard re-stamps and re-emits
 * the snapshot on an interval even when nothing changed, and the pill discards
 * any snapshot older than the expiry. A live dashboard therefore keeps the count
 * alive; a dashboard that went away lets it lapse to nothing within one expiry
 * window instead of forever.
 *
 * Pure module so the freshness rule is unit-testable without either window.
 */

/** How often the dashboard re-stamps the current snapshot. */
export const PARKED_LANES_HEARTBEAT_MS = 10_000;

/**
 * How long a received snapshot stays trustworthy. Three missed heartbeats:
 * tolerant of a busy main thread, still short enough that a reload clears a
 * wrong count before anyone reads it as current.
 */
export const PARKED_LANES_STALE_AFTER_MS = 30_000;

/**
 * Identifies one document's run. Re-evaluated on every page load, so a snapshot
 * carrying a different id is known to predate the current dashboard even when
 * its stamp is still inside the expiry window.
 */
export const PARKED_LANES_RUN_ID = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export interface ParkedLanesStatusPayload {
  count?: number;
  waiting?: number;
  repos?: string[];
  breakdown?: Record<string, number>;
  tooltip?: string | null;
  /** Wall-clock stamp from the emitting window. */
  emittedAt?: number;
  /** Identifies the dashboard run that emitted it. */
  runId?: string;
}

/**
 * A snapshot with no stamp came from a build before the heartbeat existed (an
 * older main window against a newer dock during an update). Treat it as stale
 * rather than trusting it forever — an unstamped payload is exactly the case
 * this fix exists for.
 */
export function parkedSnapshotIsStale(
  payload: Pick<ParkedLanesStatusPayload, 'emittedAt'>,
  now: number,
  staleAfterMs: number = PARKED_LANES_STALE_AFTER_MS,
): boolean {
  const emittedAt = payload.emittedAt;
  if (typeof emittedAt !== 'number' || !Number.isFinite(emittedAt)) return true;
  // A stamp from the future means the two windows disagree about the clock;
  // accept it rather than blanking a live count over clock skew.
  if (emittedAt > now) return false;
  return now - emittedAt > staleAfterMs;
}

/** Whether a received payload should replace what the pill is showing. */
export function parkedSnapshotIsUsable(payload: ParkedLanesStatusPayload, now: number): boolean {
  return !parkedSnapshotIsStale(payload, now);
}
