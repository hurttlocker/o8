import type { ApprovalRecord } from '@/lib/approvals/types';
import { listApprovalsForContext } from '@/lib/approvals/store';
import { getLaneSpokenDiffFacts } from '@/lib/lane/lane-diff-facts';
import { findLaneByPacket, getLane } from '@/lib/lane/registry';
import { buildPreviewForLane } from '@/lib/lane/preview-merge';
import { readPacketCompletionContext } from '@/lib/orchestrator/context-relay';
import { findCurrentSpokenReviewApproval } from '@/lib/orchestrator/spoken-review-evidence';
import {
  fingerprintSpokenReviewGovernance,
  type SpokenReviewResolutionTransition,
} from '@/lib/orchestrator/spoken-review-governance';

export interface SpokenReviewMutationEvidence {
  approvalId: string;
  packetId: string;
  reviewedHeadSha: string;
  reviewedDiffFingerprint: string;
  reviewedGovernanceFingerprint: string;
}

export async function currentSpokenReviewGovernanceFingerprint(
  approval: ApprovalRecord,
  lane: NonNullable<ReturnType<typeof getLane>>,
  resolutionTransition?: SpokenReviewResolutionTransition,
) {
  const currentLane = getLane(lane.id);
  if (!currentLane?.packetId) {
    throw new Error('The reviewed lane is no longer attached to a packet. Review it again.');
  }
  const current = await getLaneSpokenDiffFacts(currentLane);
  const approvals = listApprovalsForContext({
    packetId: currentLane.packetId,
    laneId: currentLane.id,
    sessionKey: currentLane.sessionKey ?? undefined,
  });
  const reviewApproval = current.dirtyFiles.length === 0 && current.untrackedFiles.length === 0
    ? findCurrentSpokenReviewApproval(approvals, currentLane.packetId, currentLane, current.headSha)
    : null;
  const [completionContext, mergePreview] = await Promise.all([
    readPacketCompletionContext(currentLane.packetId),
    buildPreviewForLane(currentLane, currentLane.packetId, {
      orchestratorApproved: reviewApproval?.status === 'approved'
        && reviewApproval.args?.approved === true,
    }),
  ]);
  return fingerprintSpokenReviewGovernance({
    targetApproval: approval,
    approvals,
    lane: currentLane,
    completionContext,
    mergePreview,
    resolutionTransition,
  });
}

function requiredString(record: Record<string, unknown>, key: keyof SpokenReviewMutationEvidence) {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function parseEvidence(value: unknown): SpokenReviewMutationEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const evidence = {
    approvalId: requiredString(record, 'approvalId'),
    packetId: requiredString(record, 'packetId'),
    reviewedHeadSha: requiredString(record, 'reviewedHeadSha'),
    reviewedDiffFingerprint: requiredString(record, 'reviewedDiffFingerprint'),
    reviewedGovernanceFingerprint: requiredString(record, 'reviewedGovernanceFingerprint'),
  };
  return Object.values(evidence).every(Boolean) ? evidence : null;
}

function packetIdForApproval(approval: ApprovalRecord) {
  const continuation = approval.continuation;
  if (continuation?.kind === 'lane' && (continuation.verb === 'merge' || continuation.verb === 'create_pr')) {
    return getLane(continuation.laneId)?.packetId?.trim() || null;
  }
  const mergePolicy = approval.policyRuleId === 'lane-merge'
    || approval.policyRuleId === 'merge-gate-violation'
    || approval.policyRuleId === 'worker-merge-governance'
    || approval.policyRuleId === 'surface-dispatcher-review';
  if (approval.toolName !== 'orchestrator_review' && !mergePolicy) return null;
  const argsPacketId = typeof approval.args?.packetId === 'string'
    ? approval.args.packetId.trim()
    : '';
  return argsPacketId || approval.metadata?.Packet?.trim() || null;
}

/**
 * Recheck receipt-bound git evidence inside the approval mutation handler.
 * The native bridge already checked before showing the card; this second check
 * closes the network gap before SQLite resolution and lane dispatch.
 */
export async function verifySpokenReviewMutationEvidence(
  value: unknown,
  approval: ApprovalRecord,
): Promise<SpokenReviewMutationEvidence | null> {
  if (value === undefined) return null;
  const evidence = parseEvidence(value);
  if (!evidence) {
    throw new Error('Spoken review evidence is incomplete. Review the packet again.');
  }
  if (evidence.approvalId !== approval.id) {
    throw new Error('Spoken review evidence belongs to a different approval.');
  }
  const approvalPacketId = packetIdForApproval(approval);
  if (!approvalPacketId || approvalPacketId !== evidence.packetId) {
    throw new Error('Spoken review evidence belongs to a different packet or action.');
  }

  const lane = approval.continuation?.kind === 'lane'
    ? getLane(approval.continuation.laneId)
    : findLaneByPacket(evidence.packetId);
  if (!lane || lane.packetId !== evidence.packetId) {
    throw new Error('The reviewed packet lane is no longer available. Review it again.');
  }
  const current = await getLaneSpokenDiffFacts(lane);
  if (current.headSha !== evidence.reviewedHeadSha) {
    throw new Error('Packet HEAD changed after the spoken review. Review it again.');
  }
  if (current.fingerprint !== evidence.reviewedDiffFingerprint) {
    throw new Error('The packet diff changed after the spoken review. Review it again.');
  }
  const governanceFingerprint = await currentSpokenReviewGovernanceFingerprint(approval, lane);
  if (governanceFingerprint !== evidence.reviewedGovernanceFingerprint) {
    throw new Error('The approval or governance state changed after the spoken review. Review it again.');
  }
  return evidence;
}
