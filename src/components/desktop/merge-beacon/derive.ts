import type { DomainLaneSummary } from '@/lib/orchestrator/store';

const REVIEWING_STATUS = 'reviewing';

export interface ReviewApprovalSummary {
  status: string;
  toolName?: string;
  metadata?: Record<string, string> | null;
}

export type ParkedLaneReviewState = 'needs-review' | 'awaiting-merge';

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
  const needsReview: ParkedLane[] = [];
  const awaitingMerge: ParkedLane[] = [];

  for (const lane of lanes) {
    if (lane.status !== REVIEWING_STATUS || closedPacketIds?.has(lane.packetId)) {
      continue;
    }
    if (hasApprovedReview(lane, approvals)) {
      awaitingMerge.push(toParkedLane(lane, 'awaiting-merge'));
    } else {
      needsReview.push(toParkedLane(lane, 'needs-review'));
    }
  }

  return {
    needsReview,
    awaitingMerge,
    all: [...needsReview, ...awaitingMerge],
  };
}

export function deriveParkedLanes(
  lanes: DomainLaneSummary[],
  closedPacketIds?: ReadonlySet<string>,
  approvals: ReviewApprovalSummary[] = [],
): ParkedLane[] {
  return deriveParkedLaneBuckets(lanes, approvals, closedPacketIds).all;
}
