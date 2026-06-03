import type { ApprovalRecord } from '@/lib/approvals/types';
import type { Lane } from '@/lib/lane/types';

function reviewedHeadForApproval(approval: ApprovalRecord): string | undefined {
  const argsHead = approval.args?.reviewedHeadSha;
  if (typeof argsHead === 'string') {
    return argsHead;
  }

  return approval.metadata?.['Reviewed HEAD'];
}

// Durable approved-review reader. This is the only signal that authorizes a
// non-user merge or PR action to skip the operator approval card.
export async function hasDurableApprovedReview(
  lane: Pick<Lane, 'id' | 'packetId' | 'sessionKey' | 'worktreePath' | 'repoPath'>,
): Promise<boolean> {
  try {
    const [{ listApprovalsForContext }, { normalizeHeadSha, readHeadSha }] = await Promise.all([
      import('@/lib/approvals/store'),
      import('@/lib/lane/head-sha-lock'),
    ]);
    const approvals = listApprovalsForContext({
      packetId: lane.packetId ?? undefined,
      laneId: lane.id,
      sessionKey: lane.sessionKey ?? undefined,
      projectId: null,
    });
    const approved = approvals.filter(
      (approval) => approval.toolName === 'orchestrator_review' && approval.status === 'approved',
    );
    if (approved.length === 0) return false;

    const cwd = lane.worktreePath || lane.repoPath;
    if (!cwd) return false;

    let currentHead: string | undefined;
    try {
      currentHead = normalizeHeadSha(await readHeadSha(cwd));
    } catch {
      return false;
    }
    if (!currentHead) return false;

    return approved.some((approval) => {
      const reviewed = normalizeHeadSha(reviewedHeadForApproval(approval));
      return reviewed !== undefined && reviewed === currentHead;
    });
  } catch {
    return false;
  }
}
