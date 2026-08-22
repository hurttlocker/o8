import { randomUUID } from 'node:crypto';

import { resolveApproval } from '@/lib/approvals/resolution';
import { createApproval, listApprovalsForContext, recordApprovalAudit } from '@/lib/approvals/store';
import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import { getLaneDiffFacts } from '@/lib/lane/lane-diff-facts';
import { normalizeHeadSha, readHeadSha } from '@/lib/lane/head-sha-lock';
import { findLaneByPacket, findLatestLaneByPacket } from '@/lib/lane/registry';
import { classifyReviewRisk } from '@/lib/lane/review-risk';
import { findActiveReviewTurn } from '@/lib/lane/review-turn-state';
import type { Lane } from '@/lib/lane/types';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import { synthesizePacketFromLane } from '@/lib/orchestrator/synthesize-packet';
import type {
  OrchestratorPacket,
  OrchestratorPacketReview,
  OrchestratorPacketReviewFinding,
} from '@/lib/orchestrator/types';
import type { ReviewCoverageEvidence } from '@/lib/orchestrator/task-contract-coverage';
import { currentMissionState, log } from './shared';
import type { SubmitReviewInput } from './types';

function highestReviewRisk(findings: OrchestratorPacketReviewFinding[]) {
  if (findings.some((finding) => finding.severity === 'high')) {
    return 'high';
  }
  if (findings.some((finding) => finding.severity === 'warning')) {
    return 'medium';
  }
  return 'low';
}

function buildReviewSummary(findings: OrchestratorReviewFinding[], approved: boolean) {
  const verdict = approved ? 'Approved' : 'Changes requested';
  if (findings.length === 0) {
    return `${verdict}. No findings recorded.`;
  }

  const topFindings = findings
    .slice(0, 3)
    .map((finding) => {
      const location = typeof finding.line === 'number' ? `${finding.file}:${finding.line}` : finding.file;
      return `${location} [${finding.severity}/${finding.resolution}] ${finding.description}`;
    })
    .join(' | ');

  return `${verdict}. ${findings.length} finding${findings.length === 1 ? '' : 's'}: ${topFindings}`;
}

function buildPacketReview(
  findings: OrchestratorReviewFinding[],
  approved: boolean,
  summary: string,
  reviewedHeadSha?: string,
  auditApprovalId?: string | null,
  directivesApplied?: string[],
  directivesViolated?: SubmitReviewInput['directivesViolated'],
): OrchestratorPacketReview {
  const review: OrchestratorPacketReview = {
    approved,
    findings: findings.map((finding) => ({
      file: finding.file,
      line: finding.line ?? null,
      severity: finding.severity === 'bug'
        ? 'high'
        : finding.severity === 'rule_violation'
          ? 'warning'
          : 'info',
      description: finding.description,
      resolution: finding.resolution,
      fixSuggestion: finding.fixSuggestion ?? null,
    })),
    recordedAt: new Date().toISOString(),
    reviewedHeadSha: normalizeHeadSha(reviewedHeadSha) ?? null,
    summary,
    auditApprovalId: auditApprovalId?.trim() || null,
  };

  if (directivesApplied && directivesApplied.length > 0) {
    review.directivesApplied = directivesApplied.slice();
  }
  if (directivesViolated && directivesViolated.length > 0) {
    review.directivesViolated = directivesViolated.map((entry) => ({
      directive: entry.directive,
      file: entry.file ?? null,
      line: typeof entry.line === 'number' ? entry.line : null,
      snippet: entry.snippet ?? null,
    }));
  }

  return review;
}

export function mapReviewSummary(packet: OrchestratorPacket) {
  const review = packet.review;
  if (!review) {
    return undefined;
  }
  const risk = highestReviewRisk(review.findings);
  return `${review.summary} Risk: ${risk}.`;
}

function deriveApprovalRisk(findings: OrchestratorReviewFinding[], approved: boolean) {
  if (!approved) {
    return 'high' as const;
  }
  if (findings.some((finding) => finding.severity === 'bug')) {
    return 'high' as const;
  }
  if (findings.length > 0) {
    return 'medium' as const;
  }
  return 'low' as const;
}

function requiresSecondPassForLane(lane: Lane | null, approved: boolean) {
  if (!approved || !lane?.worktreePath) {
    return false;
  }

  try {
    const facts = getLaneDiffFacts(lane);
    return classifyReviewRisk(facts.changedFiles, facts.addedLines).tier === 'high';
  } catch (error) {
    console.warn(`[review] Failed to classify second-pass requirement for lane ${lane.id}:`, error);
    return false;
  }
}

function hasApprovedVerdict(packet: OrchestratorPacket, lane: Lane | null): boolean {
  if (packet.review?.approved === true) return true;
  return listApprovalsForContext({
    packetId: packet.id,
    laneId: lane?.id,
    sessionKey: lane?.sessionKey ?? undefined,
  }).some((approval) => (
    approval.toolName === 'orchestrator_review'
    && approval.status === 'approved'
    && approval.args?.approved === true
    && approval.args?.reviewSuperseded !== true
  ));
}

function recordPacketReviewAudit(
  packet: OrchestratorPacket,
  findings: OrchestratorReviewFinding[],
  approved: boolean,
  summary: string,
  reviewedHeadSha: string | undefined,
  contractCoverageEvidence: ReviewCoverageEvidence | undefined,
  reviewTurn: { id: string; outcome: 'active' | 'completed' },
) {
  const lane = findLaneByPacket(packet.id);
  const requiresSecondPass = requiresSecondPassForLane(lane, approved);
  const approval = createApproval({
    source: 'runtime',
    runtime: lane?.runtime ?? packet.runtime,
    agent: lane?.label ?? packet.title,
    sessionKey: lane?.sessionKey || `packet:${packet.id}`,
    title: 'Orchestrator review',
    description: summary,
    summary: `Orchestrator review for ${packet.referenceLabel}`,
    toolName: 'orchestrator_review',
    args: {
      packetId: packet.id,
      approved,
      findings,
      reviewedHeadSha,
      contractCoverageEvidence,
      requiresSecondPass,
      secondPassAgreed: false,
      reviewTurnId: reviewTurn.id,
      reviewTurnOutcome: reviewTurn.outcome,
    },
    risk: deriveApprovalRisk(findings, approved),
    metadata: {
      Packet: packet.id,
      ...(lane ? { Lane: lane.id, Branch: lane.branch, Base: lane.baseBranch } : {}),
      ...(reviewedHeadSha ? { 'Reviewed HEAD': reviewedHeadSha } : {}),
      'Review Turn': reviewTurn.id,
      'Review Turn Outcome': reviewTurn.outcome,
    },
  });
  recordApprovalAudit(approval.id, 'orchestrator_review', 'system', summary);
  const resolved = resolveApproval(approval.id, approved ? 'approve' : 'reject', 'system', summary);
  return resolved?.id ?? approval.id;
}

export async function submitPacketReview(input: SubmitReviewInput) {
  const state = currentMissionState();
  const missionPacket = state.packets.find((candidate) => candidate.id === input.packetId);

  // #1112 — Lane-registry fallback. When a new `create_mission` runs, the
  // prior mission's packets get evicted from in-memory state. The lane row
  // is the durable source of truth (same pattern as #1106 for governance
  // reads). When the mission lookup misses but a lane exists, synthesize a
  // minimal packet stub from the lane and skip the mission-state write.
  let orphanLane: Lane | null = null;
  let packet: OrchestratorPacket;
  if (missionPacket) {
    packet = missionPacket;
  } else {
    orphanLane = findLatestLaneByPacket(input.packetId);
    if (!orphanLane) {
      throw new Error(`Packet ${input.packetId} not found.`);
    }
    packet = synthesizePacketFromLane(input.packetId, orphanLane);
  }

  // Explicit pin from the caller wins (#1363 — pass the headSha the diff was
  // read at). Fallback: capture the lane worktree HEAD at review time, which
  // authorizes the durable-review merge exactly as before but can pin a HEAD
  // whose latest commits the reviewer's diff never showed — callers that care
  // must pass reviewedHeadSha explicitly. Merge-time drift refusal
  // (head_moved_since_review) still guards commits landing after this point.
  let reviewedHeadSha = normalizeHeadSha(input.reviewedHeadSha);
  let reviewedHeadAutoCaptured = false;
  if (!reviewedHeadSha) {
    const lane = orphanLane ?? findLaneByPacket(input.packetId);
    const cwd = lane?.worktreePath?.trim() || undefined;
    if (cwd) {
      try {
        reviewedHeadSha = normalizeHeadSha(await readHeadSha(cwd));
        reviewedHeadAutoCaptured = reviewedHeadSha !== undefined;
      } catch (error) {
        console.warn(`[review] Failed to capture reviewed HEAD for packet ${input.packetId}:`, error);
      }
    }
  }
  const verdictLane = orphanLane ?? findLaneByPacket(input.packetId);
  const activeReviewTurn = verdictLane ? findActiveReviewTurn(verdictLane.id) : null;
  if (activeReviewTurn?.surface === 'packet-explainer') {
    log(`Ignored non-authoritative packet-explainer verdict for packet ${packet.id}.`, {
      approved: input.approved,
      findings: input.findings.length,
      reviewTurnId: activeReviewTurn.id,
    });
    return {
      recorded: false,
      findingsCount: 0,
      reviewedHeadSha: null,
      warning: undefined,
      auditEventType: null,
      auditApprovalId: null,
      ignoredReason: 'packet_explainer_non_authoritative',
    };
  }
  if (!input.approved && input.findings.length === 0 && hasApprovedVerdict(packet, verdictLane)) {
    log(`Ignored finding-free rejection that would replace an approved verdict for packet ${packet.id}.`, {
      reviewTurnId: activeReviewTurn?.id ?? null,
    });
    return {
      recorded: false,
      findingsCount: 0,
      reviewedHeadSha: null,
      warning: undefined,
      auditEventType: null,
      auditApprovalId: null,
      ignoredReason: 'finding_free_rejection_cannot_replace_approval',
    };
  }
  // submit_review is the completed verdict artifact even when its transport
  // turn is still streaming. Persist it as merge-authorizing immediately; the
  // turn finalizer can still downgrade and supersede it if that turn later
  // fails or exhausts quota.
  const reviewTurn = {
    id: activeReviewTurn?.id ?? `review-turn-standalone-${randomUUID()}`,
    outcome: 'completed' as const,
  };
  const summary = buildReviewSummary(input.findings, input.approved);
  const auditApprovalId = recordPacketReviewAudit(
    packet,
    input.findings,
    input.approved,
    summary,
    reviewedHeadSha,
    input.contractCoverageEvidence,
    reviewTurn,
  );

  // Only update mission state when the packet actually lives there — orphan
  // path leaves state unchanged (the audit log is the record of truth for
  // that case until the merge happens via the lane-fallback merge path).
  let resolvedAuditApprovalId: string | null = auditApprovalId ?? null;
  if (missionPacket) {
    // #1488 — mutate under the lock against a FRESH read, never a whole-state
    // write from the snapshot taken at function entry: the reviewed-HEAD
    // capture above does git I/O, and a packet created in that window (an
    // o8_task_create queued packet has no lane to reconcile back from) was
    // ERASED by the stale-snapshot write. withLockedState's end-of-lock
    // reconcile+write persists the in-place mutation.
    const { result: lockedReview } = await withLockedState((fresh) => {
      const target = fresh.packets.find((candidate) => candidate.id === packet.id);
      if (!target) return null;
      target.review = buildPacketReview(
        input.findings,
        input.approved,
        summary,
        reviewedHeadSha,
        auditApprovalId,
        input.directivesApplied,
        input.directivesViolated,
      );
      return target.review;
    });
    resolvedAuditApprovalId = lockedReview?.auditApprovalId ?? null;
  }

  // #1476 lie 3 — the verdict must survive mission-state eviction AND
  // approval-context drift (mid-merge the lane's sessionKey detaches and the
  // score-based approvals lookup can miss). Lane events are append-only and
  // keyed by lane id alone, so review-state can always recover the latest
  // verdict from here as its final fallback.
  if (verdictLane) {
    try {
      const { appendEvent } = await import('@/lib/lane/registry');
      appendEvent(verdictLane.id, 'review_recorded', 'orchestrator', {
        approved: input.approved,
        summary,
        reviewedHeadSha: reviewedHeadSha ?? null,
        auditApprovalId: resolvedAuditApprovalId,
        reviewTurnId: reviewTurn.id,
        reviewTurnOutcome: reviewTurn.outcome,
      });
    } catch (error) {
      console.warn(`[review] Failed to append review_recorded event for packet ${input.packetId}:`, error);
    }
  }

  log(`Recorded review for packet ${packet.id}${orphanLane ? ` (orphan via lane ${orphanLane.id})` : ''}.`, {
    approved: input.approved,
    findings: input.findings.length,
    reviewedHeadSha: reviewedHeadSha ?? null,
    reviewEventType: 'orchestrator_review',
  });

  return {
    recorded: true,
    findingsCount: input.findings.length,
    reviewedHeadSha: reviewedHeadSha ?? null,
    ...(reviewedHeadAutoCaptured ? {
      warning: 'reviewedHeadSha was omitted; pinned to the worktree HEAD at review time — pass the packet-diff headSha to pin exactly what you read.',
    } : {}),
    ...(reviewedHeadSha ? {} : {
      warning: 'reviewedHeadSha was omitted and no worktree HEAD was capturable; this review is unpinned.',
    }),
    auditEventType: 'orchestrator_review',
    auditApprovalId: resolvedAuditApprovalId,
  };
}
