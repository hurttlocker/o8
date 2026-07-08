/**
 * Wedge-timeout enforcement (Rock 1 item 2).
 *
 * The zombie reaper only chased heartbeat-stale `running`/`merging` lanes. A
 * lane parked in `recovering` / `awaiting_orchestrator` / `paused` /
 * `awaiting_input` had no timeout at all — it sat there forever (the "status
 * self-contradicts for hours" class). This module adds conservative
 * wedge-timeouts so nothing parks SILENTLY. The invariant is "nothing parks
 * silently", NOT "nothing parks" — `paused`/`awaiting_input` legitimately wait
 * on a human, so those only raise a reminder card and never auto-fail.
 *
 * Every escalation emits a `wedge_timeout` lane event (from→to + elapsed) and
 * is EDGE-TRIGGERED: it fires at most once per parked episode. Transition rules
 * self-dedup because the status change moves the lane out of the source bucket;
 * the reminder rule (which does not transition) dedups on "a wedge_timeout event
 * already exists newer than the lane's last activity".
 *
 * "Parked since" is derived from the lane's last event / updatedAt — any real
 * activity resets the timer, which is the honest signal.
 */

import { createApproval } from '@/lib/approvals/store';
import type { Lane, LaneStatus } from '@/lib/lane/types';
import { appendEvent, getLaneEvents, listActiveLanes, setLaneStatus } from './registry';

// Conservative defaults. Named + exported so tests and operators can reason
// about them without magic numbers.
export const WEDGE_RECOVERING_MS = 15 * 60_000; // 15 min
export const WEDGE_AWAITING_ORCHESTRATOR_MS = 60 * 60_000; // 60 min
export const WEDGE_PARKED_REMINDER_MS = 24 * 60 * 60_000; // 24 h

export type WedgeActionKind = 'escalate_orchestrator' | 'escalate_human' | 'parked_reminder';

export interface WedgeAction {
  kind: WedgeActionKind;
  from: LaneStatus;
  /** Target status for transition rules; equals `from` for the reminder rule. */
  to: LaneStatus;
  elapsedMs: number;
  thresholdMs: number;
  blockedReason: string;
  /** Whether this action changes the lane status. */
  transitions: boolean;
  /** Whether this action raises a human-facing approval card. */
  raisesCard: boolean;
}

export interface WedgeTimeoutOutcome {
  laneId: string;
  action: WedgeAction;
}

function parkedSinceMs(lane: Lane): number | null {
  const raw = lane.lastEventAt ?? lane.updatedAt;
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pure decision: given a lane + clock, what (if anything) should the reaper do?
 * No I/O — the caller handles edge-triggering and persistence.
 */
export function computeWedgeAction(lane: Lane, now: number): WedgeAction | null {
  const parkedSince = parkedSinceMs(lane);
  if (parkedSince === null) return null;
  const elapsedMs = now - parkedSince;
  if (elapsedMs < 0) return null;

  switch (lane.status) {
    case 'recovering': {
      // Phantom recovering lanes (no packet) are left to archiveStaleDeadLanes.
      // A packet-bound recovering lane that stalls past the auto-rerun window
      // must escalate to the orchestrator rather than be silently archived.
      if (!lane.packetId) return null;
      if (elapsedMs < WEDGE_RECOVERING_MS) return null;
      return {
        kind: 'escalate_orchestrator',
        from: 'recovering',
        to: 'awaiting_orchestrator',
        elapsedMs,
        thresholdMs: WEDGE_RECOVERING_MS,
        blockedReason: 'recovering_wedge_timeout',
        transitions: true,
        raisesCard: false,
      };
    }
    case 'awaiting_orchestrator': {
      if (elapsedMs < WEDGE_AWAITING_ORCHESTRATOR_MS) return null;
      // No `awaiting_human` status exists in the persisted enum, so escalate to
      // `awaiting_input` (the existing human-facing state) and raise an operator
      // card — realizing the layer-5 "human, your call" escalation.
      return {
        kind: 'escalate_human',
        from: 'awaiting_orchestrator',
        to: 'awaiting_input',
        elapsedMs,
        thresholdMs: WEDGE_AWAITING_ORCHESTRATOR_MS,
        blockedReason: 'orchestrator_wedge_timeout',
        transitions: true,
        raisesCard: true,
      };
    }
    case 'paused':
    case 'awaiting_input': {
      if (elapsedMs < WEDGE_PARKED_REMINDER_MS) return null;
      // These legitimately wait on a human — DO NOT auto-fail. Just make sure
      // the operator has a durable reminder so it isn't parked silently.
      return {
        kind: 'parked_reminder',
        from: lane.status,
        to: lane.status,
        elapsedMs,
        thresholdMs: WEDGE_PARKED_REMINDER_MS,
        blockedReason: `${lane.status}_wedge_reminder`,
        transitions: false,
        raisesCard: true,
      };
    }
    default:
      return null;
  }
}

function hasWedgeEventSince(laneId: string, sinceMs: number): boolean {
  return getLaneEvents(laneId, 50).some((event) => {
    if (event.verb !== 'wedge_timeout') return false;
    const ts = Date.parse(event.timestamp);
    return Number.isFinite(ts) && ts >= sinceMs;
  });
}

function raiseWedgeCard(lane: Lane, action: WedgeAction): void {
  const elapsedMin = Math.round(action.elapsedMs / 60_000);
  const label = lane.label || lane.branch || lane.id;
  const isReminder = action.kind === 'parked_reminder';
  try {
    createApproval({
      source: 'runtime',
      runtime: lane.runtime,
      agent: label,
      sessionKey: lane.sessionKey || `lane:${lane.id}`,
      title: isReminder
        ? 'Parked lane still waiting on you'
        : 'Lane escalated to you (orchestrator did not respond)',
      description: isReminder
        ? `Lane "${label}" has been ${action.from} for ${elapsedMin} min with no activity. Resume it, reassign it, or archive it.`
        : `Lane "${label}" waited ${elapsedMin} min for the orchestrator without a decision and was escalated to you. Steer it, retry it, or archive it.`,
      // Stable per lane+kind so repeat ticks in the same episode dedup on the
      // approval-store fingerprint (belt-and-suspenders on top of edge-trigger).
      summary: `Wedge ${action.kind} on lane ${lane.id}`,
      risk: 'medium',
      metadata: {
        Lane: lane.id,
        Status: action.to,
        ElapsedMin: String(elapsedMin),
        ...(lane.packetId ? { Packet: lane.packetId } : {}),
      },
      continuation: { kind: 'lane', laneId: lane.id, verb: 'resume' },
    });
  } catch (error) {
    console.warn(`[lane-lifecycle] failed to raise wedge card for lane ${lane.id}:`, error);
  }
}

/**
 * Enforce wedge-timeouts across all active lanes. Called from the reaper tick.
 * Returns the actions taken (for logging/tests).
 */
export function enforceWedgeTimeouts(now: number = Date.now()): WedgeTimeoutOutcome[] {
  const outcomes: WedgeTimeoutOutcome[] = [];

  for (const lane of listActiveLanes()) {
    const action = computeWedgeAction(lane, now);
    if (!action) continue;

    // Edge trigger: never re-fire within the same parked episode. `parkedSince`
    // is the lane's last activity; a wedge event newer than that means we
    // already escalated this episode.
    const parkedSince = parkedSinceMs(lane);
    if (parkedSince !== null && hasWedgeEventSince(lane.id, parkedSince)) continue;

    appendEvent(lane.id, 'wedge_timeout', 'system', {
      from: action.from,
      to: action.to,
      elapsedMs: action.elapsedMs,
      thresholdMs: action.thresholdMs,
      blockedReason: action.blockedReason,
      action: action.kind,
    });

    if (action.transitions) {
      setLaneStatus(lane.id, action.to, 'system', action.blockedReason);
    }
    if (action.raisesCard) {
      raiseWedgeCard(lane, action);
    }

    console.log(
      `[lane-lifecycle] wedge ${action.kind}: lane ${lane.id} ${action.from}` +
        `${action.transitions ? ` → ${action.to}` : ''} after ${Math.round(action.elapsedMs / 60_000)}m` +
        ` (threshold ${Math.round(action.thresholdMs / 60_000)}m)`,
    );

    outcomes.push({ laneId: lane.id, action });
  }

  return outcomes;
}
