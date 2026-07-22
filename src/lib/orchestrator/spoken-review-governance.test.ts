import { describe, expect, it } from 'vitest';

import type { ApprovalRecord } from '@/lib/approvals/types';
import type { Lane } from '@/lib/lane/types';
import {
  fingerprintSpokenReviewGovernance,
  type SpokenReviewResolutionTransition,
} from './spoken-review-governance';

function approval(verb: 'merge' | 'create_pr'): ApprovalRecord {
  return {
    id: 'approval-1',
    projectId: null,
    source: 'runtime',
    runtime: 'codex',
    agent: 'worker',
    sessionKey: 'codex:packet-1',
    title: 'Review packet',
    description: 'Review packet',
    summary: 'Review packet',
    risk: 'medium',
    policyRuleId: 'lane-merge',
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
    audit: [],
    fingerprint: 'approval-row-fingerprint',
    continuation: { kind: 'lane', laneId: 'lane-1', verb },
  };
}

const lane = {
  id: 'lane-1',
  packetId: 'packet-1',
  sessionKey: 'codex:packet-1',
  branch: 'packet/review',
  baseBranch: 'main',
  status: 'awaiting_input',
  outcome: null,
  outcomeNote: null,
} as Lane;

describe('fingerprintSpokenReviewGovernance', () => {
  it('binds the exact pending approval continuation even when Git is unchanged', () => {
    const mergeApproval = approval('merge');
    const createPrApproval = approval('create_pr');
    const mergeFingerprint = fingerprintSpokenReviewGovernance({
      targetApproval: mergeApproval,
      approvals: [mergeApproval],
      lane,
      completionContext: null,
      mergePreview: null,
    });
    const createPrFingerprint = fingerprintSpokenReviewGovernance({
      targetApproval: createPrApproval,
      approvals: [createPrApproval],
      lane,
      completionContext: null,
      mergePreview: null,
    });

    expect(createPrFingerprint).not.toBe(mergeFingerprint);
  });

  it('allows only the target approval resolution transition after speech', () => {
    const pending = approval('merge');
    const approved: ApprovalRecord = {
      ...pending,
      status: 'approved',
      updatedAt: 2,
      resolvedAt: 2,
      resolution: { action: 'approved', actor: 'desktop', claimId: 'claim-1' },
      audit: [{ type: 'approved', actor: 'desktop', timestamp: 2 }],
    };
    const transition: SpokenReviewResolutionTransition = {
      claimId: 'claim-1',
      reviewedUpdatedAt: pending.updatedAt,
      reviewedLaneStatus: lane.status,
    };
    const fingerprint = (
      targetApproval: ApprovalRecord,
      approvals: ApprovalRecord[],
      resolutionTransition = transition,
    ) => (
      fingerprintSpokenReviewGovernance({
        targetApproval,
        approvals,
        lane,
        completionContext: null,
        mergePreview: null,
        resolutionTransition,
      })
    );

    expect(fingerprint(approved, [approved])).toBe(fingerprint(pending, [pending]));
    expect(fingerprint({ ...approved, summary: 'Changed action' }, [{ ...approved, summary: 'Changed action' }]))
      .not.toBe(fingerprint(pending, [pending]));
    expect(fingerprint(approved, [approved], { ...transition, claimId: 'wrong-claim' }))
      .not.toBe(fingerprint(pending, [pending]));
    expect(fingerprint({
      ...approved,
      audit: [...approved.audit, { type: 'updated', actor: 'system', timestamp: 3 }],
    }, [{
      ...approved,
      audit: [...approved.audit, { type: 'updated', actor: 'system', timestamp: 3 }],
    }])).not.toBe(fingerprint(pending, [pending]));
  });

  it('binds lane lifecycle and terminal outcome changes', () => {
    const pending = approval('merge');
    const fingerprint = (candidateLane: Lane) => fingerprintSpokenReviewGovernance({
      targetApproval: pending,
      approvals: [pending],
      lane: candidateLane,
      completionContext: null,
      mergePreview: null,
    });

    expect(fingerprint({ ...lane, status: 'reviewing' }))
      .not.toBe(fingerprint(lane));
    expect(fingerprint({ ...lane, outcome: 'merged' }))
      .not.toBe(fingerprint(lane));
  });
});
