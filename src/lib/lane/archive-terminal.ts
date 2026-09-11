/**
 * #2154 — bulk clear for the Agents rail.
 *
 * Clearing the rail used to mean either looping one `POST /api/lanes
 * {verb:'archive'}` per lane, or `POST /api/tasks/{id}/prune` — a hard delete
 * that takes the lane records (the receipts for what an agent did) with it.
 * This is the non-destructive bulk path: every lane whose lifecycle is already
 * over moves to `archived`, the rows stay in the database, and the Archived
 * section keeps showing them.
 *
 * LIVE WORK IS NEVER TOUCHED. Eligibility is `LANE_TERMINAL_STATUSES` only
 * (`failed` / `completed`) — the set whose only legal successor is `archived`
 * (see terminal-states.ts). A running / reviewing / awaiting_* lane can never
 * match, and every lane is re-read from the registry immediately before the
 * write so one that moved off a terminal status between the listing and the
 * archive is skipped rather than retired out from under its worker.
 */
import { archiveLane, getLane, listLanes } from './registry';
import { isLaneTerminal } from './terminal-states';
import { archiveOwnedRuntimeSession } from '@/lib/runtime/owned-session-archive';
import type { Lane, LaneEventActor } from './types';

export interface TerminalLaneArchiveResult {
  /** Lane ids moved to `archived` by this call. */
  archived: string[];
  /** Lanes whose owned session dir could not be archived; the lane still was. */
  sessionArchiveFailures: string[];
}

/** Pure: the lanes a bulk clear may retire. Already-archived lanes are a no-op. */
export function terminalLanesToArchive(lanes: Lane[]): Lane[] {
  return lanes.filter((lane) => isLaneTerminal(lane.status) && lane.status !== 'archived');
}

export async function archiveTerminalLanes(
  actor: LaneEventActor = 'user',
): Promise<TerminalLaneArchiveResult> {
  const result: TerminalLaneArchiveResult = { archived: [], sessionArchiveFailures: [] };

  for (const candidate of terminalLanesToArchive(listLanes())) {
    // Re-read under the same rule the listing used: anything that left the
    // terminal set in the meantime is live again and stays untouched.
    const lane = getLane(candidate.id);
    if (!lane || !isLaneTerminal(lane.status) || lane.status === 'archived') continue;

    if (lane.sessionKey) {
      // Same session retirement the per-row Archive performs, so the runtime
      // inventory stops re-adding a row for a lane that just left the rail.
      // Best-effort: a session dir that was already cleaned up must not block
      // the lane archive, or the rail could never be cleared.
      try {
        const archivedSession = await archiveOwnedRuntimeSession(lane.sessionKey);
        if (archivedSession && !archivedSession.archived) {
          result.sessionArchiveFailures.push(lane.id);
        }
      } catch {
        result.sessionArchiveFailures.push(lane.id);
      }
    }

    if (archiveLane(lane.id, actor)) result.archived.push(lane.id);
  }

  return result;
}
