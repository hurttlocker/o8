import type { ApprovalRecord } from '@/lib/approvals/types';
import type { Lane } from './types';

function reviewedHeadForApproval(approval: ApprovalRecord): string | undefined {
  const argsHead = approval.args?.reviewedHeadSha;
  return typeof argsHead === 'string' ? argsHead : approval.metadata?.['Reviewed HEAD'];
}

function reviewVerdictTimestamp(approval: ApprovalRecord): number {
  for (let index = approval.audit.length - 1; index >= 0; index -= 1) {
    const event = approval.audit[index];
    if (event?.type === 'orchestrator_review') return event.timestamp;
  }
  return approval.createdAt;
}

function compareReviewVerdictRecency(left: ApprovalRecord, right: ApprovalRecord): number {
  return reviewVerdictTimestamp(right) - reviewVerdictTimestamp(left)
    || right.createdAt - left.createdAt
    || right.id.localeCompare(left.id);
}

export async function findPendingSecondPassApproval(lane: Lane) {
  try {
    const [{ listApprovalsForContext }, { normalizeHeadSha, readHeadSha }] = await Promise.all([
      import('@/lib/approvals/store'),
      import('@/lib/lane/head-sha-lock'),
    ]);
    const currentHeadSha = normalizeHeadSha(await readHeadSha(lane.worktreePath || lane.repoPath));
    if (!currentHeadSha) return null;
    const approvals = listApprovalsForContext({
      packetId: lane.packetId ?? undefined,
      laneId: lane.id,
      sessionKey: lane.sessionKey ?? undefined,
      projectId: null,
    });
    const latestVerdict = approvals.filter((candidate) => {
      const reviewedHeadSha = normalizeHeadSha(reviewedHeadForApproval(candidate));
      return candidate.toolName === 'orchestrator_review'
        && candidate.args?.reviewSuperseded !== true
        && reviewedHeadSha === currentHeadSha;
    }).sort(compareReviewVerdictRecency)[0];
    const approval = latestVerdict?.status === 'approved'
      && latestVerdict.args?.approved === true
      && latestVerdict.args?.requiresSecondPass === true
      && latestVerdict.args?.secondPassAgreed !== true
      ? latestVerdict
      : undefined;
    const reviewedHeadSha = approval ? normalizeHeadSha(reviewedHeadForApproval(approval)) : undefined;
    const alreadyBlocked = approval && reviewedHeadSha && approvals.some((candidate) => (
      candidate.toolName === 'orchestrator_second_pass'
      && candidate.args?.approvalId === approval.id
      && candidate.args?.reviewedHeadSha === reviewedHeadSha
    ));
    if (alreadyBlocked) return null;
    return approval && reviewedHeadSha ? { approval, reviewedHeadSha } : null;
  } catch (error) {
    console.warn(`[auto-review] Failed to find pending second-pass approval for lane ${lane.id}:`, error);
    return null;
  }
}
