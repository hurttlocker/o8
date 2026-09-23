import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { submitPacketReview } from '@/lib/orchestrator/operator-mission-service';
import { parseReviewFindings } from '@/lib/orchestrator/review-finding-input';
import { readCoverageEvidence } from '@/lib/orchestrator/task-contract-coverage';
import {
  bindIdempotencyClientMutation,
  deriveIdempotencyKey,
  withIdempotency,
} from '@/lib/orchestrator/idempotency-store';
import { asRecord, operatorError, operatorSuccess, parseJsonBody, replayShape, unresolvedIdempotencyResponse } from '../_utils';

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
  const principal = resolveRequestPrincipalContext(request);
  const ownershipRefusal = workerPacketRefusal(principal, packetId);
  if (ownershipRefusal) {
    return operatorError(ownershipRefusal.code, ownershipRefusal.message, 403);
  }

  if (typeof record.approved !== 'boolean') {
    return operatorError('invalid_request', 'approved is required.', 400);
  }
  const waiverInput = record.missingContractWaiverReason;
  if (waiverInput !== undefined && (
    principal.role !== 'operator'
    || record.approved !== true
    || typeof waiverInput !== 'string'
    || !waiverInput.trim()
    || waiverInput.trim().length > 500
    || typeof record.reviewedHeadSha !== 'string'
    || !/^[0-9a-f]{40}$/i.test(record.reviewedHeadSha.trim())
  )) {
    return operatorError(
      'invalid_missing_contract_waiver',
      'A missing-contract waiver requires an operator, an approved review, a full reviewed HEAD, and a reason of at most 500 characters.',
      principal.role === 'operator' ? 400 : 403,
    );
  }
  const clientKey = typeof record.clientMutationId === 'string'
    ? record.clientMutationId.trim()
    : typeof record.idempotencyKey === 'string'
      ? record.idempotencyKey.trim()
      : '';
  if (!clientKey) return operatorError('client_mutation_id_required', 'clientMutationId is required.', 400);
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

  const reviewInput = {
      packetId,
      findings: parseReviewFindings(record.findings),
      approved: record.approved,
      reviewedHeadSha: typeof record.reviewedHeadSha === 'string' && record.reviewedHeadSha.trim()
        ? record.reviewedHeadSha.trim()
        : undefined,
      contractCoverageEvidence: contractCoverageEvidence ?? undefined,
      ...(waiverInput !== undefined ? { missingContractWaiverReason: (waiverInput as string).trim() } : {}),
  };
  const canonicalBody = JSON.stringify(reviewInput);
  try {
    const binding = bindIdempotencyClientMutation({
      namespace: 'packet_review',
      clientKey,
      body: canonicalBody,
    });
    if (binding.status === 'conflict') {
      return operatorError('idempotency_conflict', 'clientMutationId was used for another review.', 409);
    }
    if (binding.status === 'unavailable') {
      return operatorError('idempotency_unavailable', 'The review receipt store is unavailable.', 503);
    }
    const outcome = await withIdempotency({
      key: deriveIdempotencyKey({ verb: 'packet_review', scopeId: packetId, clientKey, body: canonicalBody }),
      verb: 'packet_review',
      scopeId: packetId,
    }, async () => {
      try {
        return { ok: true as const, result: await submitPacketReview(reviewInput) };
      } catch (error) {
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : 'Unable to submit review.',
        };
      }
    });
    if (outcome.inProgress) return unresolvedIdempotencyResponse(outcome, 'packet review') ?? operatorSuccess(replayShape(outcome), 202);
    if (!outcome.result.ok) {
      const response = operatorError('review_failed', outcome.result.message, 500);
      if (outcome.replayed) response.headers.set('x-o8-idempotency-replayed', '1');
      return response;
    }
    return operatorSuccess(replayShape({ ...outcome, result: outcome.result.result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to submit review.';
    return operatorError('review_failed', message, 500, error);
  }
}
