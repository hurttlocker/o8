/**
 * Session-binding fault detector (#1502).
 *
 * A dispatched worker reports progress (`o8 packet report --event progress`) and
 * heartbeats (`o8 packet heartbeat`) as it works. Those reports resolve the lane
 * by id — but the lane's `sessionKey` is the ONLY handle to the worker's
 * transcript/rollout. If a worker is running yet its lane carries a NULL
 * sessionKey, every completion looks like a silent exit and the transcript reads
 * empty: the packet is "running into the void." Today that failure is invisible.
 *
 * This detector runs at the two seams where a live worker touches the lane —
 * the heartbeat route and the progress-report route. When an ACTIVE lane
 * reports activity with no sessionKey it:
 *   1. emits a `no_session_binding` lane event (once per lane), and
 *   2. raises a supervisor-inbox fault card (FAULT queue: human_required, never
 *      self-closes; the inbox dedupes on its incident key so it's raised once).
 *
 * Best-effort and never throws — it is a detector wrapped around real request
 * paths, so a fault in the fault-check must never break the worker's report.
 */

import { getLane, getLaneEvents } from '@/lib/lane/registry';
import { recordLaneEvent } from '@/lib/lane/events';
import { enqueueInboxItem } from '@/lib/supervisor/inbox';
import type { LaneEventVerb } from '@/lib/lane/types';

// #1502 — `no_session_binding` is a new lane-event verb owned by the
// state-machine-truth builder's union. Cast at the single emit site until it
// lands in `LaneEventVerb` (INTEGRATION: add `| 'no_session_binding'`).
const NO_SESSION_BINDING = 'no_session_binding' as unknown as LaneEventVerb;

/** Statuses where a live worker MUST have a bound session. Excludes the
 *  transient `launching`/`idle` window (binding lands mid-launch) and all
 *  terminal states. */
const ACTIVE_STATUSES = new Set(['running', 'recovering']);

/**
 * Check whether a lane is reporting activity without a session binding, and
 * raise the fault once if so. Call AFTER the heartbeat/progress side effect,
 * with the lane id the worker reported against. Safe to call on every report.
 */
export function checkSessionBindingFault(laneId: string): void {
  try {
    const trimmed = laneId?.trim();
    if (!trimmed) return;

    const lane = getLane(trimmed);
    if (!lane) return;

    // Bound → healthy. A blank string counts as unbound.
    if (lane.sessionKey && lane.sessionKey.trim()) return;

    // Only fault when a session SHOULD exist — an active worker reporting in.
    if (!ACTIVE_STATUSES.has(lane.status)) return;

    const payload = {
      packetId: lane.packetId,
      status: lane.status,
      repoPath: lane.repoPath,
      note: 'Lane reported progress/heartbeat with a null sessionKey — the worker has no transcript/rollout binding.',
    };

    // Raise the lane event at most once per lane (the inbox dedupes itself).
    const alreadyFaulted = getLaneEvents(trimmed, 200)
      .some((event) => (event.verb as string) === 'no_session_binding');
    if (!alreadyFaulted) {
      recordLaneEvent(trimmed, NO_SESSION_BINDING, 'system', payload);
    }

    // Fault card — human_required, deduped on incident key so it lands once even
    // if the alreadyFaulted guard raced across two concurrent reports.
    enqueueInboxItem({
      repoPath: lane.repoPath,
      packetId: lane.packetId,
      kind: 'no_session_binding',
      payload: { laneId: trimmed, ...payload },
    });
  } catch (error) {
    console.warn('[session-binding] fault check failed:', error instanceof Error ? error.message : error);
  }
}
