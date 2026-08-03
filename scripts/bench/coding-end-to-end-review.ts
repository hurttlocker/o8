import { getApproval } from '../../src/lib/approvals/store';
import type { DurableReviewAssessment } from '../../src/lib/lane/durable-review-approval';
import type { LaneStatus } from '../../src/lib/lane/types';
import type { OrchestratorPacketStatus } from '../../src/lib/orchestrator/types';
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
  | 'merge-preview-blocked'
  | 'blocked'
  | 'control-error'
  | 'failed'
  | 'released'
  | 'stream-lost'
  | 'timeout'
  | null;

export type GovernedConvergenceAction =
  | 'capture-approved'
  | 'request-refix'
  | 'fail-blocked'
  | 'fail-terminal'
  | 'wait';

/**
 * Decide the governed arm from the lane lifecycle, not the packet queue.
 *
 * Mission packets become `released` as soon as they leave the dispatch queue,
 * while their lane can still be running, reviewing, or refixing. The lane is
 * the production state machine. A review is settled only after the durable
 * gate authorizes the current HEAD, no review turn is active, no later
 * invalidation exists, and the worker has returned to `reviewing`.
 */
export function governedConvergenceAction(input: {
  packetStatus: OrchestratorPacketStatus | null;
  laneStatus: LaneStatus | null;
  reviewApproved: boolean | null;
  durableReviewApproved: boolean;
  reviewTurnActive: boolean;
  reviewInvalidated: boolean;
}): GovernedConvergenceAction {
  if (
    input.laneStatus === 'reviewing'
    && !input.reviewTurnActive
    && !input.reviewInvalidated
  ) {
    if (input.reviewApproved === true && input.durableReviewApproved) return 'capture-approved';
    if (input.reviewApproved === false) return 'request-refix';
  }

  if (input.laneStatus !== null) {
    switch (input.laneStatus) {
      case 'failed':
      case 'completed':
      case 'archived':
        return 'fail-terminal';
      case 'awaiting_input':
      case 'awaiting_orchestrator':
      case 'awaiting_human':
        return 'fail-blocked';
      case 'idle':
      case 'launching':
      case 'running':
      case 'paused':
      case 'recovering':
      case 'reviewing':
      case 'merging':
        return 'wait';
    }
    const exhaustive: never = input.laneStatus;
    throw new Error(`unclassified governed lane status: ${String(exhaustive)}`);
  }

  if (input.packetStatus !== null) {
    switch (input.packetStatus) {
      case 'failed':
      case 'archived':
        return 'fail-terminal';
      case 'blocked':
        return 'fail-blocked';
      case 'draft':
      case 'queued':
      case 'launching':
      case 'idle':
      case 'running':
      case 'awaiting_review':
      case 'recovering':
      case 'released':
        return 'wait';
    }
    const exhaustive: never = input.packetStatus;
    throw new Error(`unclassified governed packet status: ${String(exhaustive)}`);
  }

  return 'wait';
}

export function governedPipelineTerminalStatus(
  outcome: GovernedPipelineOutcome,
): TurnStatus.Completed | TurnStatus.Failed | null {
  if (outcome === null) return null;
  switch (outcome) {
    case 'review-approved':
      return TurnStatus.Completed;
    case 'review-bound-exhausted':
    case 'merge-preview-blocked':
    case 'blocked':
    case 'control-error':
    case 'failed':
    case 'released':
    case 'timeout':
      return TurnStatus.Failed;
    case 'stream-lost':
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
