import { NextRequest, NextResponse } from 'next/server';
import {
  listApprovalsForContext,
  listOrchestratorReviews,
  recordOrchestratorReview,
} from '@/lib/approvals/store';
import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { recordPacketReviewContext } from '@/lib/orchestrator/context-relay';
import type { OrchestratorMissionState, OrchestratorPacketReview } from '@/lib/orchestrator/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ParsedReviewPayload {
  packetId: string;
  reviewer?: string;
  approved: boolean;
  diffSha?: string;
  findings: OrchestratorReviewFinding[];
}

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseFinding(value: unknown): OrchestratorReviewFinding | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const file = typeof record.file === 'string' ? record.file.trim() : '';
  const description = typeof record.description === 'string' ? record.description.trim() : '';
  const line = typeof record.line === 'number' && Number.isFinite(record.line) && record.line > 0
    ? Math.floor(record.line)
    : undefined;
  const severity = record.severity;
  const resolution = record.resolution;

  if (!file || !description) {
    return null;
  }

  if (severity !== 'bug' && severity !== 'rule_violation' && severity !== 'note') {
    return null;
  }

  if (resolution !== 'fixed' && resolution !== 'accepted' && resolution !== 'deferred') {
    return null;
  }

  return {
    file,
    line,
    severity,
    description,
    resolution,
  };
}

function parseReviewPayload(body: unknown): { ok: true; value: ParsedReviewPayload } | { ok: false; error: string } {
  const record = asRecord(body);
  if (!record) {
    return { ok: false, error: 'Review payload is required' };
  }

  const packetId = typeof record.packetId === 'string' ? record.packetId.trim() : '';
  if (!packetId) {
    return { ok: false, error: 'packetId is required' };
  }

  if (typeof record.approved !== 'boolean') {
    return { ok: false, error: 'approved (boolean) is required' };
  }

  const findings = Array.isArray(record.findings)
    ? record.findings.map((finding) => parseFinding(finding)).filter((finding): finding is OrchestratorReviewFinding => finding !== null)
    : [];

  if (Array.isArray(record.findings) && findings.length !== record.findings.length) {
    return { ok: false, error: 'findings must contain valid review finding objects' };
  }

  const reviewer = typeof record.reviewer === 'string' && record.reviewer.trim()
    ? record.reviewer.trim()
    : undefined;
  const diffSha = typeof record.diffSha === 'string' && record.diffSha.trim()
    ? record.diffSha.trim()
    : undefined;

  return {
    ok: true,
    value: {
      packetId,
      reviewer,
      approved: record.approved,
      diffSha,
      findings,
    },
  };
}

function buildPacketReviewSummary(review: ParsedReviewPayload) {
  const reviewer = review.reviewer ?? 'orchestrator';
  const verdict = review.approved ? 'approved' : 'requested changes';
  const findingCount = review.findings.length;
  const findingsSummary = findingCount === 0
    ? 'no findings'
    : `${findingCount} finding${findingCount === 1 ? '' : 's'}`;
  const diffSummary = review.diffSha ? ` Diff ${review.diffSha}.` : '';
  return `${reviewer} ${verdict} with ${findingsSummary}.${diffSummary}`;
}

function mapPacketReviewSeverity(severity: OrchestratorReviewFinding['severity']) {
  if (severity === 'bug') {
    return 'high' as const;
  }
  if (severity === 'rule_violation') {
    return 'warning' as const;
  }
  return 'info' as const;
}

function buildPacketReview(
  review: ParsedReviewPayload,
  auditApprovalId?: string,
): OrchestratorPacketReview {
  return {
    approved: review.approved,
    findings: review.findings.map((finding) => ({
      file: finding.file,
      line: finding.line ?? null,
      severity: mapPacketReviewSeverity(finding.severity),
      description: finding.description,
      resolution: finding.resolution,
    })),
    recordedAt: new Date().toISOString(),
    summary: buildPacketReviewSummary(review),
    auditApprovalId: auditApprovalId ?? null,
  };
}

function updateMissionPacketReview(packetId: string, review: ParsedReviewPayload, auditApprovalId?: string) {
  const mission = readOrchestratorControlPlaneState();
  if (!mission.packets.some((packet) => packet.id === packetId)) {
    return null;
  }

  const nextMission: OrchestratorMissionState = {
    ...mission,
    packets: mission.packets.map((packet) => (
      packet.id === packetId
        ? {
            ...packet,
            review: buildPacketReview(review, auditApprovalId),
          }
        : packet
    )),
  };

  return writeOrchestratorControlPlaneState(nextMission);
}

export async function GET(request: NextRequest) {
  const packetId = request.nextUrl.searchParams.get('packetId')?.trim() || '';
  if (!packetId) {
    return jsonResponse({ ok: false, error: 'packetId is required' }, 400);
  }

  try {
    const reviews = listOrchestratorReviews(packetId);
    return jsonResponse({ ok: true, packetId, reviews });
  } catch (error) {
    console.error('[governance] Failed to list orchestrator reviews:', error);
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to list orchestrator reviews',
      reviews: [],
    }, 500);
  }
}

export async function POST(request: NextRequest) {
  const parsed = parseReviewPayload(await request.json().catch(() => null));
  if (!parsed.ok) {
    return jsonResponse({ ok: false, error: parsed.error }, 400);
  }

  const review = parsed.value;

  try {
    const event = recordOrchestratorReview(review.packetId, review);
    await recordPacketReviewContext(review.packetId, review);

    const auditApproval = listApprovalsForContext({ packetId: review.packetId })
      .find((approval) => approval.toolName === 'orchestrator_review');
    const mission = updateMissionPacketReview(review.packetId, review, auditApproval?.id);
    const reviews = listOrchestratorReviews(review.packetId);

    return jsonResponse({
      ok: true,
      packetId: review.packetId,
      event,
      reviews,
      auditApprovalId: auditApproval?.id ?? null,
      missionUpdated: Boolean(mission),
    }, 201);
  } catch (error) {
    console.error('[governance] Failed to record orchestrator review:', error);
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to record orchestrator review',
    }, 500);
  }
}
