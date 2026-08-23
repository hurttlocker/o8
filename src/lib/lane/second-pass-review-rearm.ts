import { recordLaneEvent } from './events';
import { enqueueLaneReview, surfaceReviewQueueBlocker } from './review-queue';
import { findPendingSecondPassApproval } from './review-verdict-recency';
import type { Lane } from './types';

export async function rearmPendingSecondPassApproval(
  lane: Lane,
  expected?: { approvalId: string; reviewedHeadSha?: string },
): Promise<{
  scheduled: boolean;
  reviewedHeadSha?: string;
  reason?: string;
}> {
  const pending = await findPendingSecondPassApproval(lane);
  if (!pending) {
    if (!expected) return { scheduled: false };
    const reason = `Approval ${expected.approvalId} requires blind second-pass review${expected.reviewedHeadSha ? ` at HEAD ${expected.reviewedHeadSha}` : ''}, but no schedulable approval was found.`;
    surfaceReviewQueueBlocker({
      laneId: lane.id,
      reviewId: `second-pass:${expected.approvalId}`,
      reason,
      attempts: 0,
    });
    return { scheduled: false, reviewedHeadSha: expected.reviewedHeadSha, reason };
  }

  if (lane.status !== 'reviewing') {
    const reason = `Blind second-pass review for HEAD ${pending.reviewedHeadSha} cannot run while lane ${lane.id} is ${lane.status}.`;
    surfaceReviewQueueBlocker({
      laneId: lane.id,
      reviewId: `second-pass:${pending.approval.id}`,
      reason,
      attempts: 0,
    });
    return { scheduled: false, reviewedHeadSha: pending.reviewedHeadSha, reason };
  }

  try {
    const queued = enqueueLaneReview(lane, { afterInProgress: true });
    recordLaneEvent(lane.id, 'second_pass_rearmed', 'system', {
      packetId: lane.packetId,
      approvalId: pending.approval.id,
      reviewedHeadSha: pending.reviewedHeadSha,
      reviewId: queued.reviewId,
      queued: queued.queued,
    });
    return { scheduled: true, reviewedHeadSha: pending.reviewedHeadSha };
  } catch (error) {
    const reason = `Blind second-pass review for HEAD ${pending.reviewedHeadSha} could not be queued: ${error instanceof Error ? error.message : String(error)}`;
    surfaceReviewQueueBlocker({
      laneId: lane.id,
      reviewId: `second-pass:${pending.approval.id}`,
      reason,
      attempts: 0,
    });
    return { scheduled: false, reviewedHeadSha: pending.reviewedHeadSha, reason };
  }
}
