import { getApproval } from '../../src/lib/approvals/store';
import type { DurableReviewAssessment } from '../../src/lib/lane/durable-review-approval';
import { TurnStatus } from './coding-arm-outcome';
import type { EndToEndCommandReceipt } from './coding-end-to-end-command';

export type { DiffFacts } from './coding-end-to-end-command';

export interface PacketDiffReceipt {
  diff?: unknown;
  truncated?: unknown;
  headSha?: unknown;
  diffBase?: { mergeBase?: string | null; comparisonRef?: string | null };
}

export type GovernedPipelineOutcome =
  | 'review-approved'
  | 'review-bound-exhausted'
  | 'blocked'
  | 'control-error'
  | 'failed'
  | 'released'
  | 'stream-lost'
  | 'timeout'
  | null;

export function governedPipelineTerminalStatus(
  outcome: GovernedPipelineOutcome,
): TurnStatus.Completed | TurnStatus.Failed | null {
  if (outcome === null) return null;
  switch (outcome) {
    case 'review-approved':
      return TurnStatus.Completed;
    case 'review-bound-exhausted':
    case 'blocked':
    case 'failed':
    case 'released':
      return TurnStatus.Failed;
    case 'control-error':
    case 'stream-lost':
    case 'timeout':
      return null;
  }
  const exhaustive: never = outcome;
  throw new Error(`unclassified governed pipeline outcome: ${String(exhaustive)}`);
}

export interface MechanicalReceipt {
  typecheck: EndToEndCommandReceipt;
  eslint: EndToEndCommandReceipt | null;
  lintedFiles: string[];
}

export interface GovernedReviewAttemptReceipt {
  attempt: number;
  approvalId: string | null;
  approved: boolean;
  reviewedHeadSha: string | null;
  recordedAt: string | null;
  summary: string;
  findings: unknown[];
  durableAssessment: DurableReviewAssessment | null;
  refix: EndToEndCommandReceipt | null;
}

interface ReviewStatus {
  approved?: unknown;
  summary?: unknown;
  recordedAt?: unknown;
  reviewedHeadSha?: unknown;
  auditApprovalId?: unknown;
}

export function reviewAttemptFromStatus(
  attempt: number,
  review: ReviewStatus,
): GovernedReviewAttemptReceipt {
  const approvalId = typeof review.auditApprovalId === 'string' ? review.auditApprovalId : null;
  const approval = approvalId ? getApproval(approvalId) : null;
  return {
    attempt,
    approvalId,
    approved: review.approved === true,
    reviewedHeadSha: typeof review.reviewedHeadSha === 'string' ? review.reviewedHeadSha : null,
    recordedAt: typeof review.recordedAt === 'string' ? review.recordedAt : null,
    summary: typeof review.summary === 'string' ? review.summary : '',
    findings: Array.isArray(approval?.args?.findings) ? approval.args.findings : [],
    durableAssessment: null,
    refix: null,
  };
}

export function reviewAttemptKey(review: ReviewStatus): string | null {
  if (typeof review.auditApprovalId === 'string') return review.auditApprovalId;
  const recordedAt = typeof review.recordedAt === 'string' ? review.recordedAt : '';
  const reviewedHeadSha = typeof review.reviewedHeadSha === 'string' ? review.reviewedHeadSha : '';
  return recordedAt || reviewedHeadSha ? `${recordedAt}:${reviewedHeadSha}` : null;
}

export function refixFeedback(
  attempt: GovernedReviewAttemptReceipt,
  assessment: DurableReviewAssessment,
): string {
  const findings = attempt.findings.length > 0
    ? JSON.stringify(attempt.findings, null, 2)
    : attempt.summary || assessment.reason;
  return (
    `Review attempt ${attempt.attempt} was rejected. Address every review finding, verify the fix, ` +
    `and return the current HEAD for a fresh review.\n\n${findings}`
  ).slice(0, 12_000);
}
