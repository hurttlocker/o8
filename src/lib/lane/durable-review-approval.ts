import type { ApprovalRecord } from '@/lib/approvals/types';
import type { Lane } from '@/lib/lane/types';

export interface DurableReviewAssessment {
  approved: boolean;
  diffBudgetWaived: boolean;
  highConfidence: boolean;
  approvalId: string | null;
  reason: string;
}

function carriesAcceptedFinding(approval: ApprovalRecord): boolean {
  const findings = approval.args?.findings;
  return Array.isArray(findings) && findings.some((finding) => (
    finding !== null
    && typeof finding === 'object'
    && (finding as { resolution?: unknown }).resolution === 'accepted'
  ));
}

function reviewedHeadForApproval(approval: ApprovalRecord): string | undefined {
  const argsHead = approval.args?.reviewedHeadSha;
  if (typeof argsHead === 'string') {
    return argsHead;
  }

  return approval.metadata?.['Reviewed HEAD'];
}

// Durable approved-review reader. This is the only signal that authorizes a
// non-user merge or PR action to skip the operator approval card.
export async function assessDurableApprovedReview(
  lane: Pick<Lane, 'id' | 'packetId' | 'sessionKey' | 'worktreePath' | 'repoPath'>,
): Promise<DurableReviewAssessment> {
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
      (approval) => (
        approval.toolName === 'orchestrator_review'
        && approval.status === 'approved'
        && approval.args?.reviewSuperseded !== true
      ),
    );
    if (approved.length === 0) {
      return { approved: false, diffBudgetWaived: false, highConfidence: false, approvalId: null, reason: 'No durable approved AI review exists.' };
    }

    const cwd = lane.worktreePath || lane.repoPath;
    if (!cwd) return { approved: false, diffBudgetWaived: false, highConfidence: false, approvalId: null, reason: 'Lane has no reviewable repository path.' };

    let currentHead: string | undefined;
    try {
      currentHead = normalizeHeadSha(await readHeadSha(cwd));
    } catch {
      return { approved: false, diffBudgetWaived: false, highConfidence: false, approvalId: null, reason: 'Current HEAD could not be verified against the AI review.' };
    }
    if (!currentHead) return { approved: false, diffBudgetWaived: false, highConfidence: false, approvalId: null, reason: 'Current HEAD is unavailable.' };

    const matchingHead = approved.filter((approval) => {
      const reviewed = normalizeHeadSha(reviewedHeadForApproval(approval));
      return reviewed !== undefined && reviewed === currentHead;
    });
    const diffBudgetWaived = matchingHead.some(carriesAcceptedFinding);
    const matching = matchingHead.find((approval) => (
      !(approval.args?.requiresSecondPass === true && approval.args?.secondPassAgreed !== true)
    ));
    if (!matching) {
      return { approved: false, diffBudgetWaived, highConfidence: false, approvalId: null, reason: 'The approved AI review does not authorize the current HEAD.' };
    }

    const highConfidence = matching.risk === 'low'
      && typeof matching.args?.parseWarning !== 'string';
    return {
      approved: true,
      diffBudgetWaived,
      highConfidence,
      approvalId: matching.id,
      reason: highConfidence
        ? 'Current HEAD has a clean, finding-free AI review.'
        : 'The AI review has findings or parser uncertainty.',
    };
  } catch {
    return { approved: false, diffBudgetWaived: false, highConfidence: false, approvalId: null, reason: 'Durable AI review lookup failed.' };
  }
}

export async function supersedeDurableApprovedReviews(packetId: string, reason: string): Promise<number> {
  try {
    const { supersedeOrchestratorReviewApprovals } = await import('@/lib/approvals/store');
    return supersedeOrchestratorReviewApprovals(packetId, reason);
  } catch (error) {
    console.error(
      `[durable-review] Could not supersede approved reviews for packet ${packetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

export async function hasDurableApprovedReview(
  lane: Pick<Lane, 'id' | 'packetId' | 'sessionKey' | 'worktreePath' | 'repoPath'>,
): Promise<boolean> {
  return (await assessDurableApprovedReview(lane)).approved;
}
