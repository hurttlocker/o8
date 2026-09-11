/**
 * #2144 — the operator-initiated way out of a lane whose checkout is gone.
 *
 * A lane that escalated (`awaiting_orchestrator` / `awaiting_human`) and then
 * lost its packet worktree to ordinary cleanup is stuck: the review surface can
 * only report a failed diff, `/api/runtime/archive` refuses the lane because it
 * is not terminal, and `DEAD_LANE_ARCHIVE_POLICY` deliberately leaves escalated
 * lanes alone. So the escalated count never reaches zero.
 *
 * The missing piece is not a weaker guard — the runtime-archive terminal check
 * and the dead-lane policy both exist for good reasons, and an escalation means
 * o8 is blocked on a HUMAN, so nothing here may fire on its own. What was
 * missing is a legitimate, explicit path: the operator, looking at the lane,
 * says discard, and o8 first proves the worktree really is gone before it
 * retires the lane. That proof is what separates this from a blanket
 * "archive any escalated lane" button.
 *
 * Discard is deliberately NOT reachable for a lane whose worktree still exists —
 * that lane has work on disk and belongs in review, not in the bin.
 */
import { existsSync } from 'node:fs';

import { archiveLane, getLane, updateLane } from './registry';
import { isLaneTerminal } from './terminal-states';
import type { Lane, LaneEventActor } from './types';

/** Stamped on a still-open lane when o8 itself removes the checkout underneath it. */
export const ORPHANED_WORKTREE_EVENT_LABEL = 'worktree_orphaned';

/** True when the lane recorded a checkout path and that path is gone from disk. */
export function laneWorktreeIsMissing(lane: Pick<Lane, 'worktreePath'>): boolean {
  const recorded = lane.worktreePath?.trim();
  if (!recorded) return false;
  return !existsSync(recorded);
}

export type OrphanedDiscardRefusalCode = 'lane_not_found' | 'already_terminal' | 'worktree_present';

export interface OrphanedDiscardRefusal {
  code: OrphanedDiscardRefusalCode;
  message: string;
}

/**
 * Pure eligibility decision for the discard action. Split out from the write so
 * the rule is testable without a registry or a filesystem.
 */
export function orphanedDiscardRefusal(
  lane: Pick<Lane, 'id' | 'status' | 'worktreePath'> | null,
  worktreeMissing: boolean,
): OrphanedDiscardRefusal | null {
  if (!lane) {
    return { code: 'lane_not_found', message: 'That lane is no longer in the registry.' };
  }
  if (isLaneTerminal(lane.status)) {
    return {
      code: 'already_terminal',
      message: `Lane ${lane.id} is already ${lane.status}; archive it the normal way.`,
    };
  }
  if (!worktreeMissing) {
    return {
      code: 'worktree_present',
      message: `Lane ${lane.id} still has its worktree on disk; review or archive it instead of discarding it.`,
    };
  }
  return null;
}

export type DiscardOrphanedLaneResult =
  | { ok: true; lane: Lane }
  | { ok: false; refusal: OrphanedDiscardRefusal };

/**
 * Retire one lane whose worktree is gone. Explicit and operator-initiated: no
 * sweep, no timer, and no caller inside the loop reaches this.
 */
export async function discardOrphanedLane(
  laneId: string,
  actor: LaneEventActor = 'user',
): Promise<DiscardOrphanedLaneResult> {
  const lane = getLane(laneId);
  const refusal = orphanedDiscardRefusal(lane, lane ? laneWorktreeIsMissing(lane) : false);
  if (refusal || !lane) {
    return { ok: false, refusal: refusal ?? { code: 'lane_not_found', message: 'That lane is no longer in the registry.' } };
  }

  if (lane.sessionKey) {
    // Best-effort, exactly as the bulk clear treats it: a session dir that is
    // already cleaned up must not block the lane from leaving the escalated set.
    try {
      // Imported lazily so this module stays cheap enough to call from the
      // worktree-removal path without dragging the runtime registry in with it.
      const { archiveOwnedRuntimeSession } = await import('@/lib/runtime/owned-session-archive');
      await archiveOwnedRuntimeSession(lane.sessionKey);
    } catch {
      // The lane archive below is the outcome that matters.
    }
  }

  const archived = archiveLane(lane.id, actor, {
    outcome: 'discarded',
    outcomeNote: `Discarded by the operator: the worktree at ${lane.worktreePath} is no longer on disk.`,
  });
  if (!archived) {
    return { ok: false, refusal: { code: 'lane_not_found', message: 'That lane is no longer in the registry.' } };
  }
  return { ok: true, lane: archived };
}

/**
 * Record — without moving the lane — that o8 just removed the checkout out from
 * under a lane that is still open. Honest at removal time instead of a surprise
 * at render time. The status is deliberately untouched: an escalated lane is
 * blocked on a human, and only the human may end it.
 */
export function markLaneWorktreeOrphaned(
  laneId: string,
  actor: LaneEventActor = 'system',
): Lane | null {
  const lane = getLane(laneId);
  if (!lane || isLaneTerminal(lane.status)) return null;
  return updateLane(
    laneId,
    { lastEventAt: new Date().toISOString(), lastEventLabel: ORPHANED_WORKTREE_EVENT_LABEL },
    actor,
    { eventLabel: ORPHANED_WORKTREE_EVENT_LABEL, worktreePath: lane.worktreePath },
  );
}
