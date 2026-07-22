import type { ApprovalRecord } from '@/lib/approvals/types';
import { normalizeHeadSha } from '@/lib/lane/head-sha-lock';
import type { Lane } from '@/lib/lane/types';

function reviewedHeadForApproval(approval: ApprovalRecord): string | undefined {
  const argsHead = approval.args?.reviewedHeadSha;
  return normalizeHeadSha(
    typeof argsHead === 'string' ? argsHead : approval.metadata?.['Reviewed HEAD'],
  );
}

function matchesLaneAttempt(
  approval: ApprovalRecord,
  packetId: string,
  lane: Lane,
): boolean {
  const approvalPacketId = typeof approval.args?.packetId === 'string'
    ? approval.args.packetId.trim()
    : approval.metadata?.Packet?.trim();
  if (approvalPacketId !== packetId) return false;

  const approvalLaneId = approval.metadata?.Lane?.trim();
  if (approvalLaneId && approvalLaneId !== lane.id) return false;

  const expectedSessionKey = lane.sessionKey?.trim();
  if (expectedSessionKey && approval.sessionKey.trim() !== expectedSessionKey) return false;

  return true;
}

/**
 * Resolve one review record that is valid for this lane attempt and exact HEAD.
 * Superseded or unpinned reviews never contribute verdicts, findings, risk, or
 * merge authorization to the spoken review.
 */
export function findCurrentSpokenReviewApproval(
  approvals: ApprovalRecord[],
  packetId: string,
  lane: Lane,
  currentHeadSha: string,
): ApprovalRecord | null {
  const normalizedHead = normalizeHeadSha(currentHeadSha);
  if (!normalizedHead) return null;

  return approvals
    .filter((approval) => approval.toolName === 'orchestrator_review')
    .filter((approval) => approval.args?.reviewSuperseded !== true)
    .filter((approval) => typeof approval.args?.approved === 'boolean')
    .filter((approval) => matchesLaneAttempt(approval, packetId, lane))
    .filter((approval) => reviewedHeadForApproval(approval) === normalizedHead)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
}
