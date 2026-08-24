/**
 * The durable "this review cannot proceed" receipt.
 *
 * Split out of `review-queue.ts` so the settlement + attempt-head layers can
 * raise a blocker without importing the enqueue chokepoint that depends on
 * them.
 */

import { recordLaneEvent } from '@/lib/lane/events';
import { getLane, setLaneStatus } from '@/lib/lane/registry';

export function surfaceReviewQueueBlocker(input: {
  laneId: string;
  reviewId: string;
  reason: string;
  attempts: number;
}): void {
  const lane = getLane(input.laneId);
  if (!lane) return;

  if (
    lane.status !== 'completed'
    && lane.status !== 'archived'
    && lane.status !== 'awaiting_orchestrator'
    && lane.status !== 'awaiting_human'
  ) {
    setLaneStatus(lane.id, 'awaiting_orchestrator', 'system', 'review_queue_failed');
  }
  recordLaneEvent(lane.id, 'review_queue_blocked', 'system', {
    packetId: lane.packetId,
    reviewId: input.reviewId,
    reason: input.reason,
    attempts: input.attempts,
  });
}
