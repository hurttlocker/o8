import type { LaneStatus } from '@/lib/lane/types';

/**
 * Terminal lane states. Once a lane lands here, only 'archived' is a valid
 * successor — everything else (awaiting_input, running, etc.) is a regression
 * and we refuse it. This guard caught a race in the supervisor that was
 * overwriting a successfully-merged lane back to awaiting_input/agent_failed
 * after the codex PTY exited (#531). Defense in depth — the supervisor
 * already avoids the double-fire at source, this stops any future caller
 * from accidentally re-opening a closed lane.
 */
export const TERMINAL_LANE_STATUSES: ReadonlySet<LaneStatus> = new Set([
  'failed',
  'completed',
  'archived',
]);

/**
 * True when a status transition would illegally re-open a terminal lane.
 * Same-status writes (idempotent re-set) and archive transitions are allowed.
 */
export function isRefusedTerminalTransition(
  currentStatus: LaneStatus,
  nextStatus: LaneStatus,
): boolean {
  return (
    TERMINAL_LANE_STATUSES.has(currentStatus)
    && nextStatus !== 'archived'
    && currentStatus !== nextStatus
  );
}
