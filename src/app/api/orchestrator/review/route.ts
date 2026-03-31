import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { submitPacketReview } from '@/lib/orchestrator/operator-mission-service';
import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizeFindingSeverity(value: unknown): OrchestratorReviewFinding['severity'] {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'bug' || normalized === 'high' || normalized === 'critical' || normalized === 'error') {
    return 'bug';
  }
  if (
    normalized === 'rule_violation'
    || normalized === 'medium'
    || normalized === 'warning'
    || normalized === 'policy'
  ) {
    return 'rule_violation';
  }
  if (normalized === 'note' || normalized === 'low' || normalized === 'info') {
    return 'note';
  }
  throw new Error(`Unsupported finding severity: ${String(value)}`);
}

function normalizeFindingResolution(value: unknown): OrchestratorReviewFinding['resolution'] {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'fixed' || normalized === 'resolved') {
    return 'fixed';
  }
  if (normalized === 'accepted' || normalized === 'waived' || normalized === 'intentional') {
    return 'accepted';
  }
  if (normalized === 'deferred' || normalized === 'todo' || normalized === 'followup' || normalized === 'follow-up') {
    return 'deferred';
  }
  throw new Error(`Unsupported finding resolution: ${String(value)}`);
}

function parseReviewFindings(value: unknown): OrchestratorReviewFinding[] {
  if (!Array.isArray(value)) {
    throw new Error('findings must be an array.');
  }

  return value.map((finding, index) => {
    const candidate = asRecord(finding);
    if (!candidate) {
      throw new Error(`findings[${index}] must be an object.`);
    }

    const file = typeof candidate.file === 'string' ? candidate.file.trim() : '';
    const description = typeof candidate.description === 'string' ? candidate.description.trim() : '';
    if (!file || !description) {
      throw new Error(`findings[${index}] must include file and description.`);
    }

    const line = candidate.line;
    if (line !== undefined && (typeof line !== 'number' || !Number.isFinite(line) || line < 1)) {
      throw new Error(`findings[${index}].line must be a positive number.`);
    }

    return {
      file,
      line: typeof line === 'number' ? Math.floor(line) : undefined,
      severity: normalizeFindingSeverity(candidate.severity),
      description,
      resolution: normalizeFindingResolution(candidate.resolution),
    };
  });
}

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

  if (typeof record.approved !== 'boolean') {
    return operatorError('invalid_request', 'approved is required.', 400);
  }

  try {
    const result = await submitPacketReview({
      packetId,
      findings: parseReviewFindings(record.findings),
      approved: record.approved,
    });
    return operatorSuccess(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to submit review.';
    return operatorError('review_failed', message, 500, error);
  }
}
