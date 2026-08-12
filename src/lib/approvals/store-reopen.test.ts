import { describe, expect, it } from 'vitest';

import {
  claimApprovalResolution,
  finalizeApprovalContinuation,
  reopenApprovalAfterEvidenceDrift,
} from './resolution';
import { createApproval, getApproval, listUnsettledApprovalContinuations } from './store';
import { getSqlite } from '@/lib/db';

function makeApproval(suffix: string) {
  return createApproval({
    source: 'runtime',
    runtime: 'codex',
    agent: 'worker',
    sessionKey: `codex:${suffix}`,
    title: `Merge ${suffix}`,
    description: 'Merge reviewed packet',
    summary: 'Merge reviewed packet',
    risk: 'medium',
    policyRuleId: 'lane-merge',
    continuation: { kind: 'lane', laneId: `lane-${suffix}`, verb: 'merge' },
  });
}

function rejectNextResolutionEvent(approvalId: string) {
  const sqlite = getSqlite();
  sqlite.exec('DROP TRIGGER IF EXISTS fail_approval_resolution_event');
  sqlite.exec(`
    CREATE TEMP TRIGGER fail_approval_resolution_event
    BEFORE INSERT ON approval_events
    WHEN NEW.approval_id = '${approvalId.replaceAll("'", "''")}'
    BEGIN
      SELECT RAISE(ABORT, 'forced approval event failure');
    END;
  `);
  return () => sqlite.exec('DROP TRIGGER IF EXISTS fail_approval_resolution_event');
}

describe('approval evidence-drift recovery', () => {
  it('keeps the approval decision separate from its continuation receipt', () => {
    const approval = makeApproval(`continuation-${Date.now()}-${Math.random()}`);
    const claim = claimApprovalResolution(approval.id, 'approve', 'desktop');

    expect(claim.approval?.resolution?.continuationStatus).toBe('pending');
    expect(finalizeApprovalContinuation(
      approval.id,
      claim.claimId!,
      'outcome_unknown',
      'The continuation receipt was lost.',
    )?.resolution?.continuationStatus).toBe('outcome_unknown');
    expect(getApproval(approval.id)?.audit.at(-1)).toMatchObject({
      type: 'continuation_outcome_unknown',
      actor: 'system',
    });
    expect(listUnsettledApprovalContinuations({ projectId: null })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: approval.id })]),
    );
  });

  it('returns an approved-but-unexecuted continuation to pending for a fresh review', () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const approval = makeApproval(suffix);
    const claim = claimApprovalResolution(approval.id, 'approve', 'desktop');
    expect(claim.approval?.status).toBe('approved');

    const reopened = reopenApprovalAfterEvidenceDrift(
      approval.id,
      claim.claimId!,
      'Packet diff changed after the spoken review.',
    );

    expect(reopened?.status).toBe('pending');
    expect(reopened?.resolvedAt).toBeUndefined();
    expect(reopened?.resolution).toBeUndefined();
    expect(reopened?.audit.at(-1)).toMatchObject({
      type: 'resume_failed',
      actor: 'system',
    });
    expect(getApproval(approval.id)?.status).toBe('pending');
  });

  it('gives exactly one resolver ownership and rejects a stale reopen', () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const approval = makeApproval(suffix);

    const winner = claimApprovalResolution(
      approval.id,
      'approve',
      'desktop',
      undefined,
      approval.updatedAt,
    );
    const loser = claimApprovalResolution(
      approval.id,
      'approve',
      'desktop',
      undefined,
      approval.updatedAt,
    );

    expect(winner.claimed).toBe(true);
    expect(loser.claimed).toBe(false);
    expect(reopenApprovalAfterEvidenceDrift(
      approval.id,
      'stale-claim',
      'Stale resolver must not reopen the winner.',
    )?.status).toBe('approved');
    expect(getApproval(approval.id)?.resolution?.claimId).toBe(winner.claimId);
  });

  it('rolls back the approval claim when its normalized ledger event cannot be written', () => {
    const approval = makeApproval(`claim-rollback-${Date.now()}-${Math.random()}`);
    const removeTrigger = rejectNextResolutionEvent(approval.id);

    try {
      expect(() => claimApprovalResolution(
        approval.id,
        'approve',
        'desktop',
        undefined,
        approval.updatedAt,
      )).toThrow('forced approval event failure');
      expect(getApproval(approval.id)).toMatchObject({
        status: 'pending',
        updatedAt: approval.updatedAt,
      });
    } finally {
      removeTrigger();
    }
  });

  it('rolls back evidence-drift reopening when its ledger event cannot be written', () => {
    const approval = makeApproval(`reopen-rollback-${Date.now()}-${Math.random()}`);
    const claim = claimApprovalResolution(approval.id, 'approve', 'desktop');
    const removeTrigger = rejectNextResolutionEvent(approval.id);

    try {
      expect(() => reopenApprovalAfterEvidenceDrift(
        approval.id,
        claim.claimId!,
        'Packet diff changed after the spoken review.',
      )).toThrow('forced approval event failure');
      expect(getApproval(approval.id)).toMatchObject({
        status: 'approved',
        resolution: { claimId: claim.claimId },
      });
    } finally {
      removeTrigger();
    }
  });
});
