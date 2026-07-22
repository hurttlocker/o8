import { describe, expect, it } from 'vitest';
import type { ApprovalRecord } from '@/lib/approvals/types';
import type { Lane } from '@/lib/lane/types';
import { findCurrentSpokenReviewApproval } from './spoken-review-evidence';

const lane = {
  id: 'lane-1218',
  packetId: 'pkt-1218',
  sessionKey: 'codex:current-attempt',
} as Lane;

function review(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 'review-current',
    projectId: null,
    source: 'runtime',
    runtime: 'codex',
    agent: 'reviewer',
    sessionKey: lane.sessionKey!,
    title: 'Orchestrator review',
    description: 'Review',
    summary: 'Review',
    toolName: 'orchestrator_review',
    args: {
      packetId: lane.packetId,
      approved: true,
      reviewedHeadSha: 'head-current',
    },
    risk: 'low',
    metadata: { Packet: lane.packetId!, Lane: lane.id, 'Reviewed HEAD': 'head-current' },
    status: 'approved',
    createdAt: 1,
    updatedAt: 1,
    audit: [],
    fingerprint: 'review-current',
    ...overrides,
  };
}

describe('findCurrentSpokenReviewApproval', () => {
  it('ignores a newer superseded review', () => {
    const current = review();
    const superseded = review({
      id: 'review-superseded',
      updatedAt: 2,
      args: { ...current.args, reviewSuperseded: true },
    });

    expect(findCurrentSpokenReviewApproval(
      [superseded, current],
      lane.packetId!,
      lane,
      'head-current',
    )?.id).toBe(current.id);
  });

  it('does not reuse a review after HEAD changes', () => {
    expect(findCurrentSpokenReviewApproval(
      [review()],
      lane.packetId!,
      lane,
      'head-new',
    )).toBeNull();
  });

  it('does not reuse a review from another session attempt', () => {
    expect(findCurrentSpokenReviewApproval(
      [review({ sessionKey: 'codex:old-attempt' })],
      lane.packetId!,
      lane,
      'head-current',
    )).toBeNull();
  });
});
