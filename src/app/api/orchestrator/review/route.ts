import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { submitPacketReview } from '@/lib/orchestrator/operator-mission-service';
import { parseReviewFindings } from '@/lib/orchestrator/review-finding-input';
import { readCoverageEvidence } from '@/lib/orchestrator/task-contract-coverage';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const packetId = typeof record.packetId === 'string' ? record.packetId.trim() : '';
  if (!packetId) {
    return operatorError('invalid_request', 'packetId is required.', 400);
  }
  const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(request), packetId);
  if (ownershipRefusal) {
    return operatorError(ownershipRefusal.code, ownershipRefusal.message, 403);
  }

  if (typeof record.approved !== 'boolean') {
    return operatorError('invalid_request', 'approved is required.', 400);
  }
  const contractCoverageEvidence = record.contractCoverageEvidence === undefined
    ? undefined
    : readCoverageEvidence({ contractCoverageEvidence: record.contractCoverageEvidence });
  if (record.contractCoverageEvidence !== undefined && !contractCoverageEvidence) {
    return operatorError(
      'invalid_request',
      'contractCoverageEvidence must include contractVersion, headSha, and requirement entries.',
      400,
    );
  }

  try {
    const result = await submitPacketReview({
      packetId,
      findings: parseReviewFindings(record.findings),
      approved: record.approved,
      reviewedHeadSha: typeof record.reviewedHeadSha === 'string' && record.reviewedHeadSha.trim()
        ? record.reviewedHeadSha.trim()
        : undefined,
      contractCoverageEvidence: contractCoverageEvidence ?? undefined,
    });
    return operatorSuccess(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to submit review.';
    return operatorError('review_failed', message, 500, error);
  }
}
