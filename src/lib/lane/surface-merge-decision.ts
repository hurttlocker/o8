import type { ApprovalGateResult } from '@/lib/approvals/types';
import { assessDurableApprovedReview } from '@/lib/lane/durable-review-approval';
import { getLaneDiffFacts } from '@/lib/lane/lane-diff-facts';
import { classifyReviewRisk } from '@/lib/lane/review-risk';
import type { Lane } from '@/lib/lane/types';

export interface SurfaceMergeDecision {
  surface: boolean;
  reasons: string[];
  hasApprovedReview: boolean;
}

export async function decideSurfaceMerge(
  lane: Lane,
  gateResult: ApprovalGateResult,
): Promise<SurfaceMergeDecision> {
  const review = await assessDurableApprovedReview(lane);
  const reasons: string[] = [];
  if (!review.highConfidence) reasons.push(review.reason);
  if (gateResult.violations.length > 0) {
    reasons.push(`Merge gate raised ${gateResult.violations.length} concern${gateResult.violations.length === 1 ? '' : 's'}.`);
  }

  try {
    const facts = getLaneDiffFacts(lane);
    const risk = classifyReviewRisk(facts.changedFiles, facts.addedLines);
    if (risk.tier === 'high') reasons.push(...risk.reasons);
  } catch {
    reasons.push('Diff risk could not be classified safely.');
  }

  return {
    surface: reasons.length > 0,
    reasons,
    hasApprovedReview: review.approved,
  };
}
