import { listApprovalsForContext } from '@/lib/approvals/store';

/** The merge service and its preview must select the same operator card. */
export function findLatestMergeApproval(packetId: string, laneId: string, sessionKey?: string | null) {
  return listApprovalsForContext({ packetId, laneId, sessionKey: sessionKey ?? undefined })
    .find(approval => approval.continuation?.kind === 'lane' && approval.continuation.verb === 'merge') ?? null;
}
