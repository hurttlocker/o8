import { describe, it, expect } from 'vitest';
import { deriveParkedLaneBuckets, deriveParkedLanes, type ReviewApprovalSummary } from './derive';
import type { DomainLaneSummary } from '@/lib/orchestrator/store';

function lane(
  partial: Partial<DomainLaneSummary> & { laneId: string; status: string },
): DomainLaneSummary {
  return {
    packetId: `p-${partial.laneId}`,
    sessionKey: null,
    lastEventLabel: null,
    ...partial,
  };
}

function approvedReview(packetId: string, laneId?: string): ReviewApprovalSummary {
  return {
    status: 'approved',
    toolName: 'orchestrator_review',
    metadata: {
      Packet: packetId,
      ...(laneId ? { Lane: laneId } : {}),
    },
  };
}

describe('deriveParkedLanes', () => {
  it('returns empty for no lanes', () => {
    expect(deriveParkedLanes([])).toEqual([]);
  });

  it('keeps reviewing + escalation states, drops in-motion + terminal states', () => {
    const lanes = [
      lane({ laneId: 'a', status: 'reviewing' }),
      lane({ laneId: 'b', status: 'running' }),
      lane({ laneId: 'c', status: 'awaiting_orchestrator' }),
      lane({ laneId: 'd', status: 'awaiting_human' }),
      lane({ laneId: 'e', status: 'merging' }),
      lane({ laneId: 'f', status: 'completed' }),
      lane({ laneId: 'g', status: 'launching' }),
    ];
    // escalated first — the strongest operator-attention signal leads the pill
    expect(deriveParkedLanes(lanes).map((p) => p.laneId)).toEqual(['c', 'd', 'a']);
  });

  it('buckets escalation-chain lanes as escalated, regardless of review approvals', () => {
    const lanes = [
      lane({ laneId: 'esc-orch', status: 'awaiting_orchestrator', packetId: 'pkt-esc-1' }),
      lane({ laneId: 'esc-human', status: 'awaiting_human', packetId: 'pkt-esc-2' }),
      lane({ laneId: 'needs', status: 'reviewing', packetId: 'pkt-needs' }),
      lane({ laneId: 'approved', status: 'reviewing', packetId: 'pkt-approved' }),
    ];
    const reviews = [approvedReview('pkt-approved'), approvedReview('pkt-esc-1')];

    const buckets = deriveParkedLaneBuckets(lanes, reviews);

    expect(buckets.escalated.map((p) => p.laneId)).toEqual(['esc-orch', 'esc-human']);
    expect(buckets.needsReview.map((p) => p.laneId)).toEqual(['needs']);
    expect(buckets.awaitingMerge.map((p) => p.laneId)).toEqual(['approved']);
    expect(buckets.all.map((p) => p.reviewState)).toEqual(['escalated', 'escalated', 'needs-review', 'awaiting-merge']);
  });

  it('drops an escalated lane whose packet is closed', () => {
    const lanes = [lane({ laneId: 'esc', status: 'awaiting_human', packetId: 'pkt-closed' })];
    expect(deriveParkedLanes(lanes, new Set(['pkt-closed']))).toEqual([]);
  });

  it('carries branch/repoPath/label through for click routing', () => {
    const parked = deriveParkedLanes([
      lane({ laneId: 'a', status: 'reviewing', branch: 'feat/x', repoPath: '/r', label: 'Fix x' }),
    ]);
    expect(parked[0]).toMatchObject({ branch: 'feat/x', repoPath: '/r', label: 'Fix x' });
  });

  it('excludes a lane whose PACKET is closed even if the lane status is stale-stuck at reviewing (the "1 ready" bug)', () => {
    const lanes = [
      lane({ laneId: 'merged', status: 'reviewing', packetId: 'pkt-merged' }), // packet merged+archived, lane status lagged
      lane({ laneId: 'live', status: 'reviewing', packetId: 'pkt-live' }),     // genuinely still parked
    ];
    const closed = new Set(['pkt-merged']);
    const parked = deriveParkedLanes(lanes, closed);
    expect(parked.map((p) => p.laneId)).toEqual(['live']); // the merged one dropped
  });

  it('splits reviewing lanes into needs-review vs approved-awaiting-merge', () => {
    const lanes = [
      lane({ laneId: 'needs', status: 'reviewing', packetId: 'pkt-needs' }),
      lane({ laneId: 'approved-by-packet', status: 'reviewing', packetId: 'pkt-approved' }),
      lane({ laneId: 'approved-by-lane', status: 'reviewing', packetId: 'pkt-other' }),
      lane({ laneId: 'running-approved', status: 'running', packetId: 'pkt-running' }),
    ];
    const reviews = [
      approvedReview('pkt-approved'),
      approvedReview('pkt-unrelated', 'approved-by-lane'),
      approvedReview('pkt-running'),
      { ...approvedReview('pkt-rejected'), status: 'rejected' },
    ];

    const buckets = deriveParkedLaneBuckets(lanes, reviews);

    expect(buckets.needsReview.map((p) => p.laneId)).toEqual(['needs']);
    expect(buckets.awaitingMerge.map((p) => p.laneId)).toEqual(['approved-by-packet', 'approved-by-lane']);
    expect(buckets.all.map((p) => p.reviewState)).toEqual(['needs-review', 'awaiting-merge', 'awaiting-merge']);
  });

  it('with no closed set, behaves exactly as before (parity)', () => {
    const lanes = [lane({ laneId: 'a', status: 'reviewing' })];
    expect(deriveParkedLanes(lanes).map((p) => p.laneId)).toEqual(['a']);
    expect(deriveParkedLanes(lanes, new Set()).map((p) => p.laneId)).toEqual(['a']);
  });

  it('buckets a reviewing lane whose latest review is rejected as `rejected`, not `needs-review`', () => {
    const lanes = [lane({ laneId: 'rej', status: 'reviewing', packetId: 'pkt-rej' })];
    const reviews: ReviewApprovalSummary[] = [
      { status: 'rejected', toolName: 'orchestrator_review', metadata: { Packet: 'pkt-rej' }, createdAt: 100 },
    ];
    const buckets = deriveParkedLaneBuckets(lanes, reviews);
    expect(buckets.rejected.map((p) => p.laneId)).toEqual(['rej']);
    expect(buckets.needsReview).toEqual([]);
    expect(buckets.all.map((p) => p.reviewState)).toEqual(['rejected']);
  });

  it('takes the LATEST review decision by createdAt (rejected then re-approved → awaiting-merge)', () => {
    const lanes = [lane({ laneId: 'flip', status: 'reviewing', packetId: 'pkt-flip' })];
    const reviews: ReviewApprovalSummary[] = [
      { status: 'rejected', toolName: 'orchestrator_review', metadata: { Packet: 'pkt-flip' }, createdAt: 100 },
      { status: 'approved', toolName: 'orchestrator_review', metadata: { Packet: 'pkt-flip' }, createdAt: 200 },
    ];
    const buckets = deriveParkedLaneBuckets(lanes, reviews);
    expect(buckets.awaitingMerge.map((p) => p.laneId)).toEqual(['flip']);
    expect(buckets.rejected).toEqual([]);
  });

  it('a later pending re-review after a rejection reads as needs-review (not a stale rejection)', () => {
    const lanes = [lane({ laneId: 'rereview', status: 'reviewing', packetId: 'pkt-rr' })];
    const reviews: ReviewApprovalSummary[] = [
      { status: 'rejected', toolName: 'orchestrator_review', metadata: { Packet: 'pkt-rr' }, createdAt: 100 },
      { status: 'pending', toolName: 'orchestrator_review', metadata: { Packet: 'pkt-rr' }, createdAt: 200 },
    ];
    const buckets = deriveParkedLaneBuckets(lanes, reviews);
    expect(buckets.needsReview.map((p) => p.laneId)).toEqual(['rereview']);
    expect(buckets.rejected).toEqual([]);
  });

  it('drops non-gating (decompose hygiene) packets from the beacon entirely', () => {
    const lanes = [
      lane({ laneId: 'hygiene', status: 'reviewing', packetId: 'decompose-123' }),
      lane({ laneId: 'real', status: 'reviewing', packetId: 'pkt-real' }),
    ];
    const nonGating = new Set(['decompose-123']);
    const parked = deriveParkedLanes(lanes, undefined, [], nonGating);
    expect(parked.map((p) => p.laneId)).toEqual(['real']); // the hygiene lane never parks the gate
  });

  it('a rejected non-gating packet also stays out of the beacon', () => {
    const lanes = [lane({ laneId: 'hygiene-rej', status: 'reviewing', packetId: 'decompose-9' })];
    const reviews: ReviewApprovalSummary[] = [
      { status: 'rejected', toolName: 'orchestrator_review', metadata: { Packet: 'decompose-9' }, createdAt: 100 },
    ];
    const parked = deriveParkedLanes(lanes, undefined, reviews, new Set(['decompose-9']));
    expect(parked).toEqual([]);
  });
});
