export interface ReviewContinuationDefault {
  /**
   * When a mission lane reaches review-ready, queue a bounded self-continuation
   * turn on the orchestrator instead of parking until the operator re-prompts.
   */
  reviewContinuation: boolean;
}

export const REVIEW_CONTINUATION_FALLBACK: ReviewContinuationDefault = {
  reviewContinuation: true,
};

export function resolveStoredReviewContinuation(
  stored: Partial<ReviewContinuationDefault>,
): Partial<ReviewContinuationDefault> {
  return typeof stored.reviewContinuation === 'boolean'
    ? { reviewContinuation: stored.reviewContinuation }
    : {};
}

export function applyReviewContinuationUpdate(
  stored: Partial<ReviewContinuationDefault>,
  update: Partial<ReviewContinuationDefault>,
): void {
  if (update.reviewContinuation !== undefined) {
    stored.reviewContinuation = Boolean(update.reviewContinuation);
  }
}
