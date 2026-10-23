import type { DurableReviewAssessment } from '@/lib/lane/durable-review-approval';
import type { OversizedChangedFile } from '@/lib/lane/file-size-policy';
import type { MergeCheckResult } from '@/lib/lane/preview-merge';
import type { Lane } from '@/lib/lane/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export interface MergeReviewRequirements {
  contractKind: 'none' | 'default-captured' | 'default-missing' | 'armed';
  contractVersion: number | null;
  captured: boolean;
  requirementIds: string[];
  processConstraintIds: string[];
  oversizedFiles: OversizedChangedFile[];
  review: Pick<DurableReviewAssessment, 'approved' | 'approvalId' | 'reason'> & { secondPassPending: boolean };
  actions: string[];
}

/** Read the same review and size assessments as merge, without requesting approval cards. */
export async function mergeReviewPrerequisites(lane: Lane, packet: OrchestratorPacket | undefined) {
  const [{ assessDurableApprovedReview }, { formatOversizedFiles, getOversizedChangedFilesForLane },
    { evaluatePolicy }, { buildLanePolicyContext }] = await Promise.all([
    import('@/lib/lane/durable-review-approval'), import('@/lib/lane/file-size-policy'),
    import('@/lib/approvals/policies'), import('@/lib/lane/commands-approval'),
  ]);
  const review = await assessDurableApprovedReview(lane);
  const oversizedFiles = await getOversizedChangedFilesForLane(lane);
  const sizePolicy = oversizedFiles.length ? evaluatePolicy(buildLanePolicyContext(lane, 'merge', 'orchestrator', {
    fileSizeLimitExceeded: true,
  })) : null;
  const sizeApprovalRequired = sizePolicy?.requiresApproval === true;
  const required = packet?.taskContractRequired === true;
  const contract = packet?.taskContract;
  const contractKind: MergeReviewRequirements['contractKind'] = !required ? 'none'
    : packet?.taskContractSource === 'default' ? contract ? 'default-captured' : 'default-missing' : 'armed';
  const actions: string[] = [];
  if (required && contract) {
    actions.push('Review the current HEAD with o8 packet review <packet-id> --approve --expected-sha <full-HEAD> --contract-version <version>; supply --coverage <requirement-id>=<changed-path> for every requirement.');
    if (contract.processConstraints?.length) actions.push('Also supply --process-evidence <constraint-id>=<transcript|lane-event|command>:<concrete-reference> for every process constraint.');
  } else if (contractKind === 'default-missing') {
    actions.push('Recover the missing runtime-default contract, or have the operator explicitly review the current HEAD with --approve --expected-sha <full-HEAD> --waive-missing-contract <bounded-reason>.');
  } else if (required) {
    actions.push('Restore or capture the explicitly armed task contract before review; a missing-contract waiver cannot clear this state.');
  }
  if (!review.approved) actions.push(review.secondPassPending
    ? 'Wait for the required blind second-pass review to agree at the current HEAD; inspect packet review state if the review is stalled.'
    : 'Record an approved review for the current committed HEAD after resolving its findings and any contract evidence failures.');
  if (sizeApprovalRequired) actions.push('Request merge to create the "Override file size limit" card, then have the operator inspect and approve that card in Approvals, or reduce the listed files below the limit.');
  const checks: MergeCheckResult[] = [
    { name: 'durable-review', verdict: review.approved ? 'pass' : 'fail', detail: review.reason },
    { name: 'file-size-approval', verdict: sizeApprovalRequired ? 'fail' : 'pass',
      detail: oversizedFiles.length ? `${formatOversizedFiles(oversizedFiles)}. ${sizeApprovalRequired ? 'Operator approval is required via the Override file size limit card.' : sizePolicy?.reason ?? 'No size override is required.'}` : 'No oversized changed files require approval.' },
  ];
  const requirements: MergeReviewRequirements = { contractKind, contractVersion: contract?.version ?? null,
    captured: Boolean(contract), requirementIds: contract?.requirements.map(r => r.id) ?? [],
    processConstraintIds: contract?.processConstraints?.map(c => c.id) ?? [], oversizedFiles,
    review: { approved: review.approved, approvalId: review.approvalId, reason: review.reason, secondPassPending: review.secondPassPending === true }, actions };
  return { review, checks, requirements, ready: review.approved && !sizeApprovalRequired };
}
