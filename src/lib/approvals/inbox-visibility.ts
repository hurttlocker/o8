import type { ApprovalRecord } from './types';

export function isOperatorDispatcherApproval(
  approval: Pick<ApprovalRecord, 'args'>,
): boolean {
  return approval.args?.approvalRoute === 'dispatcher'
    && approval.args?.dispatcherSurface === 'operator';
}

export function belongsInOperatorInbox(approval: ApprovalRecord): boolean {
  return approval.args?.approvalRoute !== 'dispatcher'
    || isOperatorDispatcherApproval(approval);
}
