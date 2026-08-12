/**
 * Unified dead-lane archiver + sweep (Recovery layer v2, 2026-07-08).
 *
 * Before this module the recovery layer had TWO archivers with divergent
 * policies:
 *   - reaper's `archiveStaleDeadLanes` — {paused, recovering} + NO session +
 *     15 min → archived (no re-probe, no owned-dir cleanup).
 *   - silent-exit's `archiveTerminallyDeadLanes` — {reviewing, recovering,
 *     awaiting_input} + a dead-LABEL + 30 min → re-probe → archived + owned-dir
 *     cleanup.
 *
 * They disagreed on the SAME `recovering` state (15 min no-session vs 30 min
 * dead-label). This module replaces both with ONE `archiveDeadLanes` driven by
 * an explicit, exported policy table (status × condition → threshold → action).
 *
 * THRESHOLD CHANGE (documented): the `recovering` + no-session rule moves from
 * the reaper's 15 min to 30 min — the SAFER (longer) of the two divergent
 * thresholds, matching the dead-label rule for the same state. A packet-bound
 * recovering lane therefore gets the full 15-min wedge window
 * (recovering → awaiting_orchestrator, see wedge-timeouts.ts) to escalate before
 * any archive rule can consider it. `paused` keeps 15 min (no divergence — only
 * the reaper ever archived it).
 */
import { archiveLane, getLane, listActiveLanes } from './registry';
import { archiveLaneSessionsConfirmed } from './reap-sessions';
import { probeLaneSessionAlive } from './owned-session-liveness';
import { enforceWedgeTimeouts } from './wedge-timeouts';
import type { Lane } from './types';

// #23 / pipeline root-fix (2026-07-03): only genuinely WORKLESS terminal states
// are auto-archivable. `silent_exit_work_present` is deliberately ABSENT —
// work-present means committed, reviewable output exists; that lane is REVIEW-
// READY, not dead, and buried three review-ready wave-1B lanes when it was in
// this set. Pinned by silent-exit-detector.test.ts.
export const DEAD_LANE_EVENT_LABELS = new Set<string>([
  'silent_exit_no_work',
  'silent_exit_verification_failed',
  'zombie_reap',
]);

const PHANTOM_NO_SESSION_PAUSED_MS = 15 * 60_000;
// Raised from the reaper's original 15 min → 30 min (see module header).
const PHANTOM_NO_SESSION_RECOVERING_MS = 30 * 60_000;
const TERMINALLY_DEAD_LABEL_MS = 30 * 60_000;

/**
 * One archive rule: which lane statuses it applies to, the extra condition on
 * top of status, the staleness threshold, and the archive action modifiers.
 */
export interface DeadLaneArchiveRule {
  id: string;
  statuses: ReadonlySet<Lane['status']>;
  /** Extra predicate: `no_session` = sessionKey is empty; `dead_label` = lastEventLabel ∈ DEAD_LANE_EVENT_LABELS. */
  condition: 'no_session' | 'dead_label';
  thresholdMs: number;
  /** Skip lanes with no parseable `lastEventAt` (the dead-label path treats a missing timestamp as "don't archive"). */
  requireTimestamp: boolean;
  /** Re-probe the owning session right before archiving so a revived lane is never archived. */
  reprobe: boolean;
  /** Also archive the owned-session dir (codex / claude-code) so UI/inventory clears. */
  cleanupOwnedSessionDir: boolean;
}

/**
 * The dead-lane archive policy. Rows are evaluated top-to-bottom; the FIRST
 * matching row whose threshold is exceeded wins. The dead-label row is first so
 * a lane carrying a dead label always gets the re-probe + owned-dir cleanup even
 * when it also happens to have no session (e.g. a `zombie_reap` recovering lane).
 */
export const DEAD_LANE_ARCHIVE_POLICY: ReadonlyArray<DeadLaneArchiveRule> = [
  {
    id: 'terminally_dead_label',
    statuses: new Set<Lane['status']>(['reviewing', 'recovering', 'awaiting_input']),
    condition: 'dead_label',
    thresholdMs: TERMINALLY_DEAD_LABEL_MS,
    requireTimestamp: true,
    reprobe: true,
    cleanupOwnedSessionDir: true,
  },
  {
    id: 'phantom_paused_no_session',
    statuses: new Set<Lane['status']>(['paused']),
    condition: 'no_session',
    thresholdMs: PHANTOM_NO_SESSION_PAUSED_MS,
    requireTimestamp: false,
    reprobe: false,
    cleanupOwnedSessionDir: false,
  },
  {
    id: 'phantom_recovering_no_session',
    statuses: new Set<Lane['status']>(['recovering']),
    condition: 'no_session',
    thresholdMs: PHANTOM_NO_SESSION_RECOVERING_MS,
    requireTimestamp: false,
    reprobe: false,
    cleanupOwnedSessionDir: false,
  },
];

function laneStaleMs(lane: Lane, now: number): { staleMs: number; hasTimestamp: boolean } {
  const lastTouch = lane.lastEventAt ? Date.parse(lane.lastEventAt) : Number.NaN;
  const hasTimestamp = Number.isFinite(lastTouch);
  return { staleMs: hasTimestamp ? now - lastTouch : Number.MAX_SAFE_INTEGER, hasTimestamp };
}

function conditionMatches(lane: Lane, condition: DeadLaneArchiveRule['condition']): boolean {
  if (condition === 'no_session') return !lane.sessionKey;
  return Boolean(lane.lastEventLabel && DEAD_LANE_EVENT_LABELS.has(lane.lastEventLabel));
}

/** Pure decision: the first policy rule that fires for this lane, or null. Exported for the table-driven test. */
export function matchDeadLaneArchiveRule(lane: Lane, now: number): DeadLaneArchiveRule | null {
  const { staleMs, hasTimestamp } = laneStaleMs(lane, now);
  for (const rule of DEAD_LANE_ARCHIVE_POLICY) {
    if (!rule.statuses.has(lane.status)) continue;
    if (!conditionMatches(lane, rule.condition)) continue;
    if (rule.requireTimestamp && !hasTimestamp) continue;
    if (staleMs <= rule.thresholdMs) continue;
    return rule;
  }
  return null;
}

/**
 * Archive every active lane a policy rule declares dead + past-threshold. Replaces
 * `archiveStaleDeadLanes` (reaper) and `archiveTerminallyDeadLanes` (silent-exit).
 * Returns the count archived.
 */
export async function archiveDeadLanes(now: number = Date.now()): Promise<number> {
  let archived = 0;
  for (const lane of listActiveLanes()) {
    const rule = matchDeadLaneArchiveRule(lane, now);
    if (!rule) continue;

    if (rule.reprobe) {
      // Re-confirm the session is really dead so we never archive a revived one,
      // and re-read the lane in case another actor advanced it while we probed.
      const alive = await probeLaneSessionAlive(lane);
      if (lane.sessionKey && alive !== false) continue;
      const refreshed = getLane(lane.id);
      if (!refreshed || !rule.statuses.has(refreshed.status)) continue;
    }

    try {
      if (rule.cleanupOwnedSessionDir && lane.sessionKey) {
        const refreshed = getLane(lane.id);
        if (!refreshed || refreshed.sessionKey !== lane.sessionKey || !rule.statuses.has(refreshed.status)) continue;
        await archiveLaneSessionsConfirmed([refreshed]);
      }
      if (!archiveLane(lane.id, 'system')) continue;
      archived += 1;
      console.log(
        `[lane-lifecycle] archived dead lane ${lane.id} (rule ${rule.id}, ${lane.status}, label=${lane.lastEventLabel ?? 'none'})`,
      );
    } catch (error) {
      console.warn(`[lane-lifecycle] archive failed for lane ${lane.id}:`, error);
    }
  }
  return archived;
}

/**
 * The dead-owner sweep: wedge-timeout escalation THEN archive, in one pass.
 *
 * Structural ordering (replaces the reaper's old hard-coded "call
 * enforceWedgeTimeouts() before archiveStaleDeadLanes()" comment + ordering): the
 * wedge runs FIRST so a packet-bound `launching`/`recovering` lane escalates to
 * the orchestrator (→ awaiting_orchestrator) BEFORE any archive rule can evaluate
 * it — a packet is never silently archived out from under the orchestrator. The
 * ordering is now a property of this function's body, not a fragile call-site
 * convention.
 */
export async function runDeadLaneSweep(now: number = Date.now()): Promise<{ wedged: number; archived: number }> {
  let wedged = 0;
  try {
    wedged = enforceWedgeTimeouts(now).length;
  } catch (error) {
    console.error('[lane-lifecycle] wedge-timeout enforcement failed:', error);
  }
  const archived = await archiveDeadLanes(now);
  return { wedged, archived };
}
