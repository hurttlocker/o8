/**
 * Match the common packet fan-out without allowing dispatch width to create an
 * unbounded number of reviewer turns or resident backend processes.
 */
export const REVIEW_CONCURRENCY_LIMIT = 3;

interface ReviewClaim {
  id: string;
  lane_id: string;
  claim_owner: string;
}

const activeReviewClaims = new Map<number, ReviewClaim>();
const reviewingLanes = new Map<string, string>();

function claimGeneration(review: ReviewClaim): string {
  return `${review.id}\u0000${review.claim_owner}`;
}

export function isLaneAutoReviewActive(laneId: string): boolean {
  return reviewingLanes.has(laneId);
}

export function activeLaneReviewExists(laneId: string): boolean {
  return reviewingLanes.has(laneId);
}

export function nextAvailableReviewSlot(): number | null {
  for (let slot = 0; slot < REVIEW_CONCURRENCY_LIMIT; slot += 1) {
    if (!activeReviewClaims.has(slot)) return slot;
  }
  return null;
}

export function activateReviewSlot(slot: number, review: ReviewClaim): void {
  activeReviewClaims.set(slot, review);
  reviewingLanes.set(review.lane_id, claimGeneration(review));
}

export function releaseLaneReviewClaim(review: ReviewClaim): void {
  if (reviewingLanes.get(review.lane_id) === claimGeneration(review)) {
    reviewingLanes.delete(review.lane_id);
  }
}

export function releaseReviewSlot(slot: number, review: ReviewClaim): void {
  releaseLaneReviewClaim(review);
  const active = activeReviewClaims.get(slot);
  if (active?.id === review.id && active.claim_owner === review.claim_owner) {
    activeReviewClaims.delete(slot);
  }
}

export function releaseStaleLaneReviewClaims(
  isCurrent: (review: ReviewClaim) => boolean,
): void {
  for (const review of activeReviewClaims.values()) {
    if (!isCurrent(review)) releaseLaneReviewClaim(review);
  }
}

export function activeReviewClaimCount(): number {
  return activeReviewClaims.size;
}

export function reviewerSessionThreadId(
  slot: number,
  pass: 'primary' | 'verdict-retry' | 'blind',
): string {
  return `thoughts-auto-review-${pass}-${slot}`;
}
