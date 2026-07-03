import type { ApprovalRecord } from '@/lib/approvals/types';
import { listApprovalsForContext } from '@/lib/approvals/store';
import { checkExpectedHeadSha, normalizeHeadSha } from '@/lib/lane/head-sha-lock';
import type { Lane } from '@/lib/lane/types';

export interface ReviewedHeadIntegrityMatch {
  ok: true;
  reviewedHeadSha?: string;
  currentHeadSha?: string;
}

export interface ReviewedHeadIntegrityMismatch {
  ok: false;
  reviewedHeadSha: string;
  currentHeadSha: string;
}

export type ReviewedHeadIntegrityResult =
  | ReviewedHeadIntegrityMatch
  | ReviewedHeadIntegrityMismatch;

function reviewedHeadForApproval(approval: ApprovalRecord): string | undefined {
  const latestAuditHead = approval.audit
    .slice()
    .reverse()
    .find((event) => event.type === 'orchestrator_review' && event.approved === true)
    ?.reviewedHeadSha;
  const argsHead = typeof approval.args?.reviewedHeadSha === 'string'
    ? approval.args.reviewedHeadSha
    : undefined;
  return normalizeHeadSha(latestAuditHead)
    ?? normalizeHeadSha(argsHead)
    ?? normalizeHeadSha(approval.metadata?.['Reviewed HEAD']);
}

export function latestRecordedReviewedHeadSha(
  lane: Pick<Lane, 'id' | 'packetId' | 'sessionKey'>,
): string | undefined {
  return listApprovalsForContext({
    packetId: lane.packetId ?? undefined,
    laneId: lane.id,
    sessionKey: lane.sessionKey ?? undefined,
    projectId: null,
  })
    .filter((approval) => (
      approval.toolName === 'orchestrator_review'
      && approval.status === 'approved'
      && approval.args?.approved !== false
    ))
    .sort((left, right) => (
      (right.resolvedAt ?? right.updatedAt) - (left.resolvedAt ?? left.updatedAt)
    ))
    .map(reviewedHeadForApproval)
    .find((head): head is string => Boolean(head));
}

export async function checkReviewedHeadIntegrity(
  lane: Pick<Lane, 'id' | 'packetId' | 'sessionKey'>,
  cwd: string,
): Promise<ReviewedHeadIntegrityResult> {
  const reviewedHeadSha = latestRecordedReviewedHeadSha(lane);
  if (!reviewedHeadSha) {
    return { ok: true };
  }

  const result = await checkExpectedHeadSha(cwd, reviewedHeadSha);
  if (result.ok) {
    return {
      ok: true,
      reviewedHeadSha,
      currentHeadSha: result.currentHeadSha,
    };
  }

  return {
    ok: false,
    reviewedHeadSha: result.expectedHeadSha,
    currentHeadSha: result.currentHeadSha,
  };
}

export function formatReviewedHeadMismatchNote(result: ReviewedHeadIntegrityMismatch) {
  return `Worktree HEAD changed since review: reviewed ${result.reviewedHeadSha}, current ${result.currentHeadSha}. Re-review before merging.`;
}
