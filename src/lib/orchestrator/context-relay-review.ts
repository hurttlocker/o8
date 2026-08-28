import { listApprovalsForContext } from '@/lib/approvals/store';
import type { ApprovalRecord, OrchestratorReviewFinding } from '@/lib/approvals/types';
import type { Lane } from '@/lib/lane/types';

export function isReviewFinding(value: unknown): value is OrchestratorReviewFinding {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  return typeof candidate.file === 'string'
    && typeof candidate.description === 'string'
    && (candidate.line === undefined || (typeof candidate.line === 'number' && Number.isFinite(candidate.line)))
    && (candidate.severity === 'bug' || candidate.severity === 'rule_violation' || candidate.severity === 'note')
    && (candidate.resolution === 'fixed' || candidate.resolution === 'accepted' || candidate.resolution === 'deferred')
    && (candidate.fixSuggestion === undefined || typeof candidate.fixSuggestion === 'string');
}

function reviewVerdictTimestamp(approval: ApprovalRecord): number {
  for (let index = approval.audit.length - 1; index >= 0; index -= 1) {
    const event = approval.audit[index];
    if (event?.type === 'orchestrator_review') return event.timestamp;
  }
  return approval.resolvedAt ?? approval.updatedAt;
}

export function readLatestPersistedReview(
  context: { packetId: string; sessionKey: string },
  lane: Lane,
): { approved: boolean; findings: OrchestratorReviewFinding[] } | null {
  const approval = listApprovalsForContext({
    packetId: context.packetId,
    laneId: lane.id,
    sessionKey: context.sessionKey,
  }).filter((candidate) => (
    candidate.toolName === 'orchestrator_review'
    && candidate.args?.reviewSuperseded !== true
    && typeof candidate.args?.approved === 'boolean'
  )).sort((left, right) => (
    reviewVerdictTimestamp(right) - reviewVerdictTimestamp(left)
    || right.createdAt - left.createdAt
    || right.id.localeCompare(left.id)
  ))[0];
  if (!approval || typeof approval.args?.approved !== 'boolean') return null;

  return {
    approved: approval.args.approved,
    findings: Array.isArray(approval.args.findings)
      ? approval.args.findings.filter(isReviewFinding)
      : [],
  };
}
