import type { LaneStatus } from '@/lib/lane/types';

/**
 * Lane-lifecycle terminal-state truth — the SINGLE source.
 *
 * Two genuinely different notions live here. Before Rock 1 they were split
 * across this file and `lane/types.ts` and disagreed on `reviewing`, so callers
 * asking "is this lane terminal?" got different answers depending on which
 * helper they happened to import (the "status self-contradicts" class).
 *
 * ── LANE_TERMINAL ─────────────────────────────────────────────────────────
 * The lane's lifecycle is OVER. Once a lane lands here, only `archived` is a
 * valid successor — every other transition is a regression we refuse. This is
 * the write-guard set (`isRefusedTerminalTransition`) that caught the #531
 * supervisor race which overwrote a merged lane back to awaiting_input.
 * `reviewing` is deliberately NOT here — `reviewing → merging → completed` is a
 * legal forward path, so treating `reviewing` as re-open-refused would wedge the
 * merge pipeline.
 *
 * ── WORKER_TERMINAL ───────────────────────────────────────────────────────
 * The WORKER has stopped producing new work; pollers/operators treat the packet
 * as done-for-the-worker even though the LANE may still have a merge ahead of
 * it. Superset of LANE_TERMINAL plus `reviewing` (work done, awaiting merge).
 * Used by the session-liveness reconcile (don't downgrade a finished lane back
 * to `running` just because a dead session still emits transcript, #1282) and
 * by mission-stop (a finished worker needs no kill).
 */
export const LANE_TERMINAL_STATUSES: ReadonlySet<LaneStatus> = new Set<LaneStatus>([
  'failed',
  'completed',
  'archived',
]);

/**
 * @deprecated Legacy alias for {@link LANE_TERMINAL_STATUSES}. Kept so existing
 * imports keep resolving; prefer the explicit name at new call sites.
 */
export const TERMINAL_LANE_STATUSES: ReadonlySet<LaneStatus> = LANE_TERMINAL_STATUSES;

export const WORKER_TERMINAL_STATUSES: ReadonlySet<LaneStatus> = new Set<LaneStatus>([
  ...LANE_TERMINAL_STATUSES,
  'reviewing',
]);

/**
 * True when the lane's lifecycle is finished (only `archived` may follow).
 * Null-safe: unknown/absent status is never terminal.
 */
export function isLaneTerminal(status: LaneStatus | null | undefined): boolean {
  return Boolean(status && LANE_TERMINAL_STATUSES.has(status));
}

/**
 * True when the worker has stopped producing — includes `reviewing` (work done,
 * awaiting merge) on top of the lane-terminal set. Null-safe.
 */
export function isWorkerTerminal(status: LaneStatus | null | undefined): boolean {
  return Boolean(status && WORKER_TERMINAL_STATUSES.has(status));
}

/**
 * True when a status transition would illegally re-open a lane-terminal lane.
 * Same-status writes (idempotent re-set) and archive transitions are allowed.
 */
export function isRefusedTerminalTransition(
  currentStatus: LaneStatus,
  nextStatus: LaneStatus,
): boolean {
  return (
    LANE_TERMINAL_STATUSES.has(currentStatus)
    && nextStatus !== 'archived'
    && currentStatus !== nextStatus
  );
}
