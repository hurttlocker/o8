import type { ApprovalRisk } from '@/lib/approvals/types';
import { buildPolicyContext } from '@/lib/approvals/policies';
import { createApproval, recordApprovalAudit } from '@/lib/approvals/store';
import { resolveRequireApprovalSync } from '@/lib/operator/defaults';
import { buildConflictZonesFromDiffFiles, extractReviewFindings, extractReviewPatterns } from '@/lib/orchestrator/review-lessons';
import { parseGitDiff } from '@/lib/worktree/diff-parser';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { setLaneStatus } from '@/lib/lane/registry';
import type { Lane, LaneCommandResult, LaneEventActor } from '@/lib/lane/types';
import { resolvePacketDispatcher } from '@/lib/orchestrator/dispatcher-attribution';
import { assessDurableApprovedReview } from './durable-review-approval';
import { preserveAndRecordLaneRecovery } from './merge-recovery';

const RECOVERABLE_MERGE_FAILURE_POLICIES = new Set([
  'merge-gate-violation',
  'rebase_conflict_escalation',
  'fast_forward_failure_escalation',
]);

async function getDiffForLane(lane: Pick<Lane, 'baseBranch' | 'worktreePath' | 'repoPath'>) {
  const cwd = lane.worktreePath || lane.repoPath;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  try {
    const result = await execFileAsync('git', ['diff', `${lane.baseBranch}...HEAD`, '--no-color'], { cwd, maxBuffer: 10 * 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    try {
      const fallback = await execFileAsync('git', ['diff', 'HEAD~1', '--no-color'], { cwd, maxBuffer: 10 * 1024 * 1024 });
      return fallback.stdout.trim();
    } catch {
      return '';
    }
  }
}

async function recordReviewLessonsForApproval(
  approvalId: string,
  lane: Lane,
  reviewSummary: string | undefined,
  files: ReturnType<typeof parseGitDiff>,
) {
  const summary = reviewSummary?.trim();
  if (!summary) {
    return;
  }

  const findings = extractReviewFindings(summary);
  const patterns = extractReviewPatterns(summary, findings);
  const conflictZones = buildConflictZonesFromDiffFiles(files);
  const approved = /\b(approve|approved|looks correct|ready to merge|ship it)\b/i.test(summary)
    ? true
    : /\b(request changes|reject|den(y|ied)|not ready|blocked)\b/i.test(summary)
      ? false
      : findings.length === 0;

  recordApprovalAudit(approvalId, 'orchestrator_review', 'orchestrator', summary, {
    findings: findings.length > 0 ? findings : undefined,
    reviewer: 'orchestrator',
    approved,
    patterns: patterns.length > 0 ? patterns : undefined,
    conflictZones: conflictZones.length > 0 ? conflictZones : undefined,
  });

  if (!lane.packetId || !lane.sessionKey) {
    return;
  }

  try {
    const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
    await capturePacketCompletionContext(lane.packetId, lane.sessionKey);
  } catch (error) {
    console.error(`[context-relay] Failed to refresh reviewed packet context for ${lane.packetId}:`, error);
  }
}

export function buildLanePolicyContext(
  lane: Pick<Lane, 'id' | 'repoPath'>,
  verb: 'create_pr' | 'merge',
  actor: LaneEventActor,
  opts?: {
    orchestratorReviewed?: boolean;
    fileSizeLimitExceeded?: boolean;
    gatePassed?: boolean;
    hasApprovedReview?: boolean;
    surfaceReviewRequired?: boolean;
  },
) {
  const requireApproval = resolveRequireApprovalSync();
  const autoReview = actor === 'orchestrator' && opts?.hasApprovedReview === true;
  return buildPolicyContext('lane_command', {
    verb,
    laneId: lane.id,
    autoReview,
    fileSizeLimitExceeded: opts?.fileSizeLimitExceeded === true,
    surfaceReviewRequired: opts?.surfaceReviewRequired === true,
  }, {
    workspacePath: lane.repoPath,
    requireApproval,
  });
}

export async function createLaneActionApproval(
  lane: Lane,
  actor: LaneEventActor,
  input: {
    verb: 'merge' | 'create_pr';
    commitMessage?: string;
    expectedHeadSha?: string;
    reviewSummary?: string;
    title: string;
    description: string;
    summary: string;
    risk: ApprovalRisk;
    policyRuleId: string;
    metadata?: Record<string, string>;
    note: string;
    gateResult?: import('@/lib/approvals/types').ApprovalGateResult;
    conflictReport?: import('@/lib/approvals/types').ApprovalConflictReport;
    strategy?: import('@/lib/approvals/types').MergeStrategy;
  },
): Promise<LaneCommandResult> {
  let approvedMergeFailure = false;
  let recovery: Awaited<ReturnType<typeof preserveAndRecordLaneRecovery>> = null;
  if (input.verb === 'merge' && RECOVERABLE_MERGE_FAILURE_POLICIES.has(input.policyRuleId)) {
    const review = await assessDurableApprovedReview(lane);
    approvedMergeFailure = review.approved;
    if (approvedMergeFailure) {
      try {
        recovery = await preserveAndRecordLaneRecovery(lane, input.policyRuleId, { reviewed: true });
      } catch (error) {
        console.error(
          `[merge-recovery] Failed to bank reviewed work for lane ${lane.id}; keeping the lane operator-actionable:`,
          error,
        );
      }
    }
  }
  const rawDiff = await getDiffForLane(lane);
  const files = parseGitDiff(rawDiff);
  const surfaceRoute = resolveRequireApprovalSync() === 'surface' && lane.packetId
    ? resolvePacketDispatcher(lane.packetId) ?? {
        dispatcher: { surface: 'operator' as const, id: 'desktop' },
        missionId: null,
      }
    : null;
  const approval = createApproval({
    source: 'runtime',
    runtime: lane.runtime,
    agent: lane.label || lane.branch,
    sessionKey: lane.sessionKey || `lane:${lane.id}`,
    title: input.title,
    description: recovery ? `${input.description}\n\n${recovery.message}` : input.description,
    summary: input.summary,
    diff: {
      path: 'multi-file',
      after: rawDiff || undefined,
      files,
    },
    gateResult: input.gateResult,
    conflictReport: input.conflictReport,
    risk: input.risk,
    policyRuleId: input.policyRuleId,
    args: surfaceRoute || recovery ? {
      ...(surfaceRoute ? {
        approvalRoute: 'dispatcher',
        dispatcherSurface: surfaceRoute.dispatcher.surface,
        dispatcherId: surfaceRoute.dispatcher.id,
        ...(surfaceRoute.missionId ? { dispatcherMissionId: surfaceRoute.missionId } : {}),
      } : {}),
      ...(recovery ? {
        preservedRef: recovery.preservedRef,
        preservedHeadSha: recovery.preservedHeadSha,
      } : {}),
    } : undefined,
    metadata: {
      Lane: lane.id,
      Branch: lane.branch,
      Base: lane.baseBranch,
      Runtime: lane.runtime,
      ...(lane.packetId ? { Packet: lane.packetId } : {}),
      ...(input.expectedHeadSha ? { 'Expected HEAD': input.expectedHeadSha } : {}),
      ...(recovery ? {
        'Recovery Ref': recovery.preservedRef,
        'Recovery HEAD': recovery.preservedHeadSha ?? 'unknown',
        'Recovery Action': recovery.recommendedAction,
      } : {}),
      ...(surfaceRoute ? {
        'Approval Route': 'dispatcher',
        'Dispatcher Surface': surfaceRoute.dispatcher.surface,
        'Dispatcher ID': surfaceRoute.dispatcher.id,
        ...(surfaceRoute.missionId ? { 'Dispatcher Mission': surfaceRoute.missionId } : {}),
      } : {}),
      ...input.metadata,
    },
    continuation: {
      kind: 'lane',
      laneId: lane.id,
      verb: input.verb,
      commitMessage: input.commitMessage,
      expectedHeadSha: input.expectedHeadSha,
      strategy: input.strategy,
    },
  });
  await recordReviewLessonsForApproval(approval.id, lane, input.reviewSummary, files);
  setLaneStatus(
    lane.id,
    approvedMergeFailure && input.policyRuleId === 'merge-gate-violation'
      ? 'reviewing'
      : approvedMergeFailure ? 'awaiting_orchestrator' : 'awaiting_input',
    actor,
    approvedMergeFailure && input.policyRuleId === 'merge-gate-violation'
      ? 'merge_gate_blocked_after_approval'
      : approvedMergeFailure ? 'merge_blocked_recoverable' : surfaceRoute ? 'dispatcher_review_required' : 'approval_required',
  );
  void publishRealtimeMutation({
    mutation: {
      mutationId: `approval-create-${approval.id}`,
      source: 'desktop',
      action: 'approve',
      sessionKey: approval.sessionKey,
      surfaceId: surfaceRoute?.dispatcher.id ?? approval.sessionKey,
      status: 'pending',
      note: `Approval required: ${approval.title}`,
      createdAt: new Date().toISOString(),
    },
    refreshTargets: surfaceRoute ? ['global'] : ['global', 'mobileInbox'],
    sessionKeys: [surfaceRoute?.dispatcher.id ?? approval.sessionKey],
    fresh: true,
  });
  if (surfaceRoute?.dispatcher.surface === 'agent' && surfaceRoute.dispatcher.id !== lane.packetId) {
    const dispatcherPacketId = surfaceRoute.dispatcher.id;
    void import('@/lib/orchestrator/operator-mission-service/steer')
      .then(({ steerPacket }) => steerPacket({
        packetId: dispatcherPacketId,
        source: 'orchestrator',
        message: `Packet ${lane.packetId ?? lane.id} needs your review before merge. Inspect it with o8 packet diff ${lane.packetId ?? ''} and respond to approval ${approval.id}.`,
      }))
      .catch((error) => {
        console.error(`[surface-approval] Failed to ping agent dispatcher ${dispatcherPacketId}:`, error);
      });
  }
  return {
    ok: false,
    laneId: lane.id,
    note: recovery ? `${input.note} ${recovery.message}` : input.note,
    approvalId: approval.id,
  };
}
