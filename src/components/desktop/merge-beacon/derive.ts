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
  /** Used to pick the LATEST review decision for a lane — a packet can be
   *  reviewed more than once (rejected, then re-reviewed). Optional so older
   *  callers stay compatible. */
  createdAt?: number;
}

export type ParkedLaneReviewState = 'needs-review' | 'awaiting-merge' | 'escalated' | 'rejected';

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
  rejected: ParkedLane[];
  needsReview: ParkedLane[];
  awaitingMerge: ParkedLane[];
  all: ParkedLane[];
}

function reviewMatchesLane(approval: ReviewApprovalSummary, lane: DomainLaneSummary) {
  if (approval.toolName !== 'orchestrator_review') {
    return false;
  }
  const packetId = approval.metadata?.Packet?.trim() ?? '';
  const laneId = approval.metadata?.Lane?.trim() ?? '';
  return packetId === lane.packetId || laneId === lane.laneId;
}

/**
 * The status of the most recent orchestrator review for a lane. A packet can be
 * reviewed multiple times (rejected → re-reviewed), so we take the latest row by
 * `createdAt` and read its status — NOT "any approved row exists". This is what
 * lets a rejected packet read as `rejected` instead of `needs-review` (a review
 * DID happen; it came back bad), and keeps a later pending re-review as
 * `needs-review` rather than a stale rejection. Returns null when the lane has
 * never been reviewed.
 */
function latestReviewStatus(lane: DomainLaneSummary, approvals: ReviewApprovalSummary[]): string | null {
  let latest: ReviewApprovalSummary | null = null;
  for (const approval of approvals) {
    if (!reviewMatchesLane(approval, lane)) continue;
    if (!latest || (approval.createdAt ?? 0) >= (latest.createdAt ?? 0)) {
      latest = approval;
    }
  }
  return latest?.status ?? null;
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
 * @param nonGatingPacketIds packetIds whose packet is best-effort and NOT a
 *   merge gate — governance hygiene cleanup (`packetType === 'decompose'`, the
 *   800-line-ceiling fan-out). Its own brief says "best-effort cleanup, not a
 *   merge gate", so it must NOT demand an operator dot in the review beacon
 *   (Q ruling 2026-07-11). It still lives in the left packet list; it just
 *   doesn't park the gate.
 */
export function deriveParkedLaneBuckets(
  lanes: DomainLaneSummary[],
  approvals: ReviewApprovalSummary[] = [],
  closedPacketIds?: ReadonlySet<string>,
  nonGatingPacketIds?: ReadonlySet<string>,
): ParkedLaneBuckets {
  const escalated: ParkedLane[] = [];
  const rejected: ParkedLane[] = [];
  const needsReview: ParkedLane[] = [];
  const awaitingMerge: ParkedLane[] = [];

  for (const lane of lanes) {
    if (closedPacketIds?.has(lane.packetId)) {
      continue;
    }
    if (nonGatingPacketIds?.has(lane.packetId)) {
      continue;
    }
    if (ESCALATED_STATUSES.has(lane.status)) {
      escalated.push(toParkedLane(lane, 'escalated'));
      continue;
    }
    if (lane.status !== REVIEWING_STATUS) {
      continue;
    }
    const reviewStatus = latestReviewStatus(lane, approvals);
    if (reviewStatus === 'approved') {
      awaitingMerge.push(toParkedLane(lane, 'awaiting-merge'));
    } else if (reviewStatus === 'rejected') {
      rejected.push(toParkedLane(lane, 'rejected'));
    } else {
      needsReview.push(toParkedLane(lane, 'needs-review'));
    }
  }

  return {
    escalated,
    rejected,
    needsReview,
    awaitingMerge,
    all: [...escalated, ...rejected, ...needsReview, ...awaitingMerge],
  };
}

export function deriveParkedLanes(
  lanes: DomainLaneSummary[],
  closedPacketIds?: ReadonlySet<string>,
  approvals: ReviewApprovalSummary[] = [],
  nonGatingPacketIds?: ReadonlySet<string>,
): ParkedLane[] {
  return deriveParkedLaneBuckets(lanes, approvals, closedPacketIds, nonGatingPacketIds).all;
}
