import { createHash } from 'node:crypto';

import type { ApprovalRecord } from '@/lib/approvals/types';
import type { Lane, LaneStatus } from '@/lib/lane/types';
import type { MergePreviewResult } from '@/lib/lane/preview-merge';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
  );
}

function relevantGovernanceApproval(approval: ApprovalRecord, targetApprovalId: string) {
  return approval.id === targetApprovalId
    || approval.toolName === 'orchestrator_review'
    || approval.toolName === 'orchestrator_second_pass';
}

export interface SpokenReviewResolutionTransition {
  claimId: string;
  reviewedUpdatedAt: number;
  reviewedLaneStatus: LaneStatus;
}

function isExactOwnedResolution(
  approval: ApprovalRecord,
  transition?: SpokenReviewResolutionTransition,
) {
  const lastAudit = approval.audit.at(-1);
  return Boolean(
    transition
    && approval.status === 'approved'
    && approval.resolution?.action === 'approved'
    && approval.resolution.actor === 'desktop'
    && approval.resolution.claimId === transition.claimId
    && approval.resolvedAt === approval.updatedAt
    && lastAudit?.type === 'approved'
    && lastAudit.actor === 'desktop'
    && lastAudit.timestamp === approval.resolvedAt,
  );
}

function targetApprovalProjection(
  approval: ApprovalRecord,
  transition?: SpokenReviewResolutionTransition,
) {
  const exactOwnedTransition = isExactOwnedResolution(approval, transition);
  if (!exactOwnedTransition) return approval;
  const pending: ApprovalRecord = {
    ...approval,
    status: 'pending' as const,
    updatedAt: transition!.reviewedUpdatedAt,
    audit: approval.audit.slice(0, -1),
  };
  delete pending.resolvedAt;
  delete pending.resolution;
  return pending;
}

/**
 * Bind the spoken decision state that is not represented by Git content:
 * exact approval version/continuation, review findings, second pass, worker
 * completion evidence, merge-gate projection, and lane attempt identity.
 */
export function fingerprintSpokenReviewGovernance(input: {
  targetApproval: ApprovalRecord;
  approvals: ApprovalRecord[];
  lane: Lane;
  completionContext: unknown;
  mergePreview: MergePreviewResult | null;
  resolutionTransition?: SpokenReviewResolutionTransition;
}) {
  const targetApproval = targetApprovalProjection(
    input.targetApproval,
    input.resolutionTransition,
  );
  const normalizeOwnLaneTransition = Boolean(
    isExactOwnedResolution(input.targetApproval, input.resolutionTransition)
    && input.lane.status === 'merging',
  );
  const material = {
    targetApproval,
    governanceApprovals: input.approvals
      .filter((approval) => relevantGovernanceApproval(approval, input.targetApproval.id))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((approval) => (
        approval.id === input.targetApproval.id
          ? targetApprovalProjection(approval, input.resolutionTransition)
          : approval
      )),
    lane: {
      id: input.lane.id,
      packetId: input.lane.packetId,
      sessionKey: input.lane.sessionKey,
      branch: input.lane.branch,
      baseBranch: input.lane.baseBranch,
      runtime: input.lane.runtime,
      ownership: input.lane.ownership,
      prNumber: input.lane.prNumber,
      status: normalizeOwnLaneTransition
        ? input.resolutionTransition!.reviewedLaneStatus
        : input.lane.status,
      outcome: input.lane.outcome,
      outcomeNote: input.lane.outcomeNote,
    },
    completionContext: input.completionContext,
    mergePreview: input.mergePreview,
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(material)))
    .digest('hex');
}
