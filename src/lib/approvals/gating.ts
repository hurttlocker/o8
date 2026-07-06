import type { ApprovalRecord } from '@/lib/approvals/types';

export const GATE_POLICY_RULE_IDS = new Set([
  'lane-merge',
  'pr-creation',
  'merge-gate-violation',
  'file_size_limit',
  'file-deletion',
  'blocked-shell',
  'destructive-shell',
  'database-migration',
  'sensitive-file-write',
  'lane-open',
]);

export function isGateApprovalRow(approval: Pick<ApprovalRecord, 'continuation' | 'policyRuleId'>) {
  return approval.continuation != null
    || (approval.policyRuleId ? GATE_POLICY_RULE_IDS.has(approval.policyRuleId) : false);
}
