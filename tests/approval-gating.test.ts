import { describe, expect, it } from 'vitest';
import { GATE_POLICY_RULE_IDS, isGateApprovalRow } from '@/lib/approvals/gating';
import type { ApprovalRecord } from '@/lib/approvals/types';

function approval(overrides: Partial<ApprovalRecord>): ApprovalRecord {
  return {
    id: 'appr-test',
    projectId: null,
    source: 'runtime',
    runtime: 'test',
    agent: 'test',
    sessionKey: 'test:session',
    title: 'Test approval',
    description: 'Test approval',
    summary: 'Test approval',
    risk: 'medium',
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
    audit: [],
    fingerprint: 'test-fingerprint',
    ...overrides,
  };
}

describe('isGateApprovalRow', () => {
  it('treats every non-null continuation as a gate', () => {
    for (const kind of ['lane', 'plan', 'runtime', 'llm-chat', 'future-kind']) {
      expect(isGateApprovalRow(approval({
        continuation: { kind } as ApprovalRecord['continuation'],
      })), kind).toBe(true);
    }
  });

  it('treats locked gate policy ids as gates without a continuation', () => {
    for (const policyRuleId of GATE_POLICY_RULE_IDS) {
      expect(isGateApprovalRow(approval({ policyRuleId })), policyRuleId).toBe(true);
    }
  });

  it('treats decorative hook rows without continuations as info', () => {
    expect(isGateApprovalRow(approval({ policyRuleId: undefined, continuation: undefined }))).toBe(false);
    expect(isGateApprovalRow(approval({ policyRuleId: 'claude-code-pretool-ask-user' }))).toBe(false);
  });

  it('does not depend on mutable risk', () => {
    expect(isGateApprovalRow(approval({ risk: 'medium', continuation: { kind: 'runtime' } as ApprovalRecord['continuation'] }))).toBe(true);
    expect(isGateApprovalRow(approval({ risk: 'high', policyRuleId: 'decorative-audit-row' }))).toBe(false);
  });
});
