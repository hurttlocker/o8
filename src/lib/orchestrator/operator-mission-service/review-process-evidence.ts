import { listApprovalsForContext, supplementReviewCoverageEvidence } from '@/lib/approvals/store';
import { allFindingsResolved } from '@/lib/approvals/orchestrator-review';
import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import { findLaneByPacket } from '@/lib/lane/registry';
import { readHeadSha } from '@/lib/lane/head-sha-lock';
import { findActiveReviewTurn } from '@/lib/lane/review-turn-state';
import { resolvePacketTaskContractGate } from '@/lib/lane/task-contract-gate';
import { assessDurableApprovedReview, listChangedPathsForCoverage } from '@/lib/lane/durable-review-approval';
import { evaluateContractCoverage, readCoverageEvidence, type ReviewCoverageEvidence } from '@/lib/orchestrator/task-contract-coverage';
import { ReviewValidationError } from './review-validation';

/** Operator-only evidence repair. An unavailable observation is never a waiver of code coverage. */
export async function supplementPacketReviewProcessEvidence(input: {
  packetId: string;
  reviewedHeadSha?: string;
  contractCoverageEvidence?: ReviewCoverageEvidence;
}) {
  const refuse = (message: string): never => {
    throw new ReviewValidationError('invalid_process_evidence_supplement', message);
  };
  const lane = findLaneByPacket(input.packetId);
  const head = input.reviewedHeadSha;
  if (!lane || !head || !/^[0-9a-f]{40}$/.test(head)
    || findActiveReviewTurn(lane.id)
    || await readHeadSha(lane.worktreePath || lane.repoPath, lane.repoPath) !== head) {
    return refuse('Process evidence must target a settled review at the full current packet HEAD.');
  }
  const currentReview = () => listApprovalsForContext({ packetId: input.packetId, laneId: lane.id })
    .filter(a => a.toolName === 'orchestrator_review' && a.args?.reviewSuperseded !== true)
    .sort((a, b) => {
      const time = (review: typeof a) => [...review.audit].reverse().find(e => e.type === 'orchestrator_review')?.timestamp ?? review.updatedAt;
      return time(b) - time(a) || b.updatedAt - a.updatedAt || b.id.localeCompare(a.id);
    })[0];
  const approval = currentReview();
  const findings = approval?.args?.findings;
  if (!approval || approval.status !== 'approved' || approval.args?.approved !== true
    || approval.args?.reviewedHeadSha !== head || approval.args?.reviewTurnOutcome !== 'completed'
    || !Array.isArray(findings) || !allFindingsResolved(findings as OrchestratorReviewFinding[])) {
    return refuse('Only the latest completed, approved code review with resolved findings can receive process evidence.');
  }
  const prior = readCoverageEvidence(approval.args);
  const incoming = input.contractCoverageEvidence;
  const gate = await resolvePacketTaskContractGate({ lane });
  // CLI coverage flags carry IDs and paths only. Keep the reviewer's original
  // anchors/verification, and compare the file claims independently of order.
  const fileClaims = (e: ReviewCoverageEvidence) => e.entries
    .map(entry => JSON.stringify([entry.requirementId, entry.productionPath])).sort().join('\n');
  if (!prior || !incoming || !gate.enforceCoverage || !gate.taskContract
    || prior.headSha !== head || incoming.headSha !== head
    || prior.contractVersion !== incoming.contractVersion
    || fileClaims(prior) !== fileClaims(incoming)
    || !incoming.processEntries?.length) {
    return refuse('Supply process citations for the existing contract, HEAD and unchanged file coverage.');
  }
  const constraints = new Set(gate.taskContract.processConstraints?.map(c => c.id));
  if (incoming.processEntries.some(e => !constraints.has(e.constraintId))) return refuse('Unknown process constraint.');
  const evidence = { ...prior, processEntries: [...new Map([
    ...(prior.processEntries ?? []), ...incoming.processEntries,
  ].map(entry => [entry.constraintId, entry])).values()] };
  const changed = await listChangedPathsForCoverage(lane, lane.worktreePath || lane.repoPath, head);
  if (!changed.resolved) return refuse('The packet diff base could not be resolved.');
  const coverage = evaluateContractCoverage({ contract: gate.taskContract, contractRequired: true,
    evidence, reviewedHeadSha: head, changedPaths: changed.paths });
  if (coverage.status !== 'passed') return refuse(coverage.reason);
  if (!supplementReviewCoverageEvidence(approval.id, approval.updatedAt, evidence,
    () => !findActiveReviewTurn(lane.id) && currentReview()?.id === approval.id)) {
    return refuse('Review advanced while evidence was being checked. Inspect the current review before retrying.');
  }
  return { recorded: true, findingsCount: findings.length, reviewedHeadSha: head,
    auditApprovalId: approval.id, contractCoverage: coverage,
    review: await assessDurableApprovedReview(lane) };
}
