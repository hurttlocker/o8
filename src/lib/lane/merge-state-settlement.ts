import { appendEvent, getLane, setLaneStatus, updateLane } from './registry';
import type { LaneCommandResult, LaneEventActor } from './types';

/**
 * `merging` is an in-flight claim, never a resting state. Every returned merge
 * result must leave the lane terminal on success or actionable on failure.
 */
export function settleReturnedMergeState(
  laneId: string,
  result: LaneCommandResult,
  actor: LaneEventActor,
): LaneCommandResult {
  const lane = getLane(laneId);
  if (lane?.status !== 'merging') return result;

  appendEvent(laneId, 'update', 'system', {
    event: 'merge_transient_settled',
    ok: result.ok,
    reason: result.reason ?? null,
    note: result.note,
  });
  if (result.ok) {
    updateLane(laneId, {
      outcome: 'merged',
      outcomeNote: result.note,
    }, 'system');
    const completed = setLaneStatus(laneId, 'completed', actor, 'merged_result_reconciled');
    return { ...result, lane: completed ?? result.lane };
  }

  const reviewing = setLaneStatus(laneId, 'reviewing', 'system', 'merge_failed_reconciled');
  return { ...result, lane: reviewing ?? result.lane };
}
