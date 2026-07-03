import type { DomainLaneSummary } from '@/lib/orchestrator/store';

const REVIEWING_STATUS = 'reviewing';
// Lanes parked in the merge-failure escalation chain (CLAUDE.md layers 2/5) —
// the strongest operator-attention signal the beacon carries. Dropping them
// made escalated packets invisible (wave-2 review regression, 2026-07-03).
const ESCALATED_STATUSES = new Set(['awaiting_orchestrator', 'awaiting_human']);

export interface ReviewApprovalSummary {
  status: string;
  toolName?: string;
  metadata?: Record<string, string> | null;
}

export type ParkedLaneReviewState = 'needs-review' | 'awaiting-merge' | 'escalated';

export interface ParkedLane {
  laneId: string;
  packetId: string;
  status: string;
  reviewState: ParkedLaneReviewState;
  branch?: string;
  repoPath?: string;
  label?: string;
}

export interface ParkedLaneBuckets {
  escalated: ParkedLane[];
  needsReview: ParkedLane[];
  awaitingMerge: ParkedLane[];
  all: ParkedLane[];
}

function approvalMatchesLane(approval: ReviewApprovalSummary, lane: DomainLaneSummary) {
  if (approval.toolName !== 'orchestrator_review' || approval.status !== 'approved') {
    return false;
  }

  const packetId = approval.metadata?.Packet?.trim() ?? '';
  const laneId = approval.metadata?.Lane?.trim() ?? '';
  return packetId === lane.packetId || laneId === lane.laneId;
}

function hasApprovedReview(lane: DomainLaneSummary, approvals: ReviewApprovalSummary[]) {
  return approvals.some((approval) => approvalMatchesLane(approval, lane));
}

function toParkedLane(lane: DomainLaneSummary, reviewState: ParkedLaneReviewState): ParkedLane {
  return {
    laneId: lane.laneId,
    packetId: lane.packetId,
    status: lane.status,
    reviewState,
    branch: lane.branch,
    repoPath: lane.repoPath,
    label: lane.label,
  };
}

/**
 * @param closedPacketIds packetIds whose packet is merged / released / archived
 *   (terminal). A lane's `status` can lag behind its packet — a packet merges +
 *   archives while the lane summary is still stale-stuck at 'reviewing' — which
 *   left the just-merged lane counting as "1 ready" in the footer beacon. Gating
 *   on the PACKET's terminal state (which IS updated on merge) drops it: a
 *   closed/merged/archived lane must never count as ready.
 */
export function deriveParkedLaneBuckets(
  lanes: DomainLaneSummary[],
  approvals: ReviewApprovalSummary[] = [],
  closedPacketIds?: ReadonlySet<string>,
): ParkedLaneBuckets {
  const escalated: ParkedLane[] = [];
  const needsReview: ParkedLane[] = [];
  const awaitingMerge: ParkedLane[] = [];

  for (const lane of lanes) {
    if (closedPacketIds?.has(lane.packetId)) {
      continue;
    }
    if (ESCALATED_STATUSES.has(lane.status)) {
      escalated.push(toParkedLane(lane, 'escalated'));
      continue;
    }
    if (lane.status !== REVIEWING_STATUS) {
      continue;
    }
    if (hasApprovedReview(lane, approvals)) {
      awaitingMerge.push(toParkedLane(lane, 'awaiting-merge'));
    } else {
      needsReview.push(toParkedLane(lane, 'needs-review'));
    }
  }

  return {
    escalated,
    needsReview,
    awaitingMerge,
    all: [...escalated, ...needsReview, ...awaitingMerge],
  };
}

export function deriveParkedLanes(
  lanes: DomainLaneSummary[],
  closedPacketIds?: ReadonlySet<string>,
  approvals: ReviewApprovalSummary[] = [],
): ParkedLane[] {
  return deriveParkedLaneBuckets(lanes, approvals, closedPacketIds).all;
}
