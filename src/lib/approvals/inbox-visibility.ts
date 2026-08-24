import type { ApprovalRecord } from './types';

export function belongsInOperatorInbox(approval: ApprovalRecord): boolean {
  return approval.args?.approvalRoute !== 'dispatcher'
    || approval.args?.dispatcherSurface === 'operator';
}
