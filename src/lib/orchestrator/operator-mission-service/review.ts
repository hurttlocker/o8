import { createApproval, recordApprovalAudit, resolveApproval } from '@/lib/approvals/store';
import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import { findLaneByPacket } from '@/lib/lane/registry';
import { writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import type {
  OrchestratorPacket,
  OrchestratorPacketReview,
  OrchestratorPacketReviewFinding,
} from '@/lib/orchestrator/types';
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
  auditApprovalId?: string | null,
): OrchestratorPacketReview {
  return {
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
    })),
    recordedAt: new Date().toISOString(),
    summary,
    auditApprovalId: auditApprovalId?.trim() || null,
  };
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

function recordPacketReviewAudit(packet: OrchestratorPacket, findings: OrchestratorReviewFinding[], approved: boolean, summary: string) {
  const lane = findLaneByPacket(packet.id);
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
    },
    risk: deriveApprovalRisk(findings, approved),
    metadata: {
      Packet: packet.id,
      ...(lane ? { Lane: lane.id, Branch: lane.branch, Base: lane.baseBranch } : {}),
    },
  });
  recordApprovalAudit(approval.id, 'orchestrator_review', 'system', summary);
  const resolved = resolveApproval(approval.id, approved ? 'approve' : 'reject', 'system', summary);
  return resolved?.id ?? approval.id;
}

export async function submitPacketReview(input: SubmitReviewInput) {
  const state = currentMissionState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  if (!packet) {
    throw new Error(`Packet ${input.packetId} not found.`);
  }

  const summary = buildReviewSummary(input.findings, input.approved);
  const auditApprovalId = recordPacketReviewAudit(packet, input.findings, input.approved, summary);

  const finalState = writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState({
    ...state,
    packets: state.packets.map((candidate) => candidate.id === packet.id
      ? {
          ...candidate,
          review: buildPacketReview(input.findings, input.approved, summary, auditApprovalId),
        }
      : candidate),
  }));

  log(`Recorded review for packet ${packet.id}.`, {
    approved: input.approved,
    findings: input.findings.length,
    reviewEventType: 'orchestrator_review',
  });

  return {
    recorded: true,
    findingsCount: input.findings.length,
    auditEventType: 'orchestrator_review',
    auditApprovalId: finalState.packets.find((candidate) => candidate.id === packet.id)?.review?.auditApprovalId ?? null,
  };
}
