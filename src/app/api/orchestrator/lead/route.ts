import { NextRequest } from 'next/server';

import {
  getLeadStatus,
  LeadLifecycleError,
  sendLead,
  startLead,
  stopLead,
  validateLeadBrief,
  waitForLead,
} from '@/lib/orchestrator/lead-lifecycle';
import { requirePanelAuth } from '@/lib/panel/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof LeadLifecycleError) {
    return json({
      schema: 'o8/orchestrator.lead.error/v1',
      ok: false,
      error: { code: error.code, message: error.message },
    }, error.status);
  }
  console.error('[orchestrator-lead] Request failed:', error);
  return json({
    schema: 'o8/orchestrator.lead.error/v1',
    ok: false,
    error: { code: 'lead_request_failed', message: 'The lead request failed.' },
  }, 500);
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LeadLifecycleError('The request body must be an object.', 'invalid_lead_request', 400);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export async function POST(request: NextRequest): Promise<Response> {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  try {
    const body = bodyRecord(await request.json().catch(() => null));
    if (body.action === 'start') {
      return json(startLead({
        repoPath: optionalString(body.repoPath) ?? '',
        backend: body.backend as 'codex' | 'claude',
        model: optionalString(body.model) ?? '',
        effort: body.effort as never,
        idempotencyKey: optionalString(body.idempotencyKey) ?? '',
        brief: validateLeadBrief(body.brief),
      }), 202);
    }
    if (body.action === 'send') {
      return json(sendLead({
        leadId: optionalString(body.leadId) ?? '',
        message: optionalString(body.message) ?? '',
        idempotencyKey: optionalString(body.idempotencyKey) ?? '',
        repoPath: optionalString(body.repoPath),
        threadId: optionalString(body.threadId),
        backend: optionalString(body.backend) as never,
        model: optionalString(body.model),
        effort: optionalString(body.effort),
      }), 202);
    }
    if (body.action === 'stop') {
      return json(stopLead(
        optionalString(body.leadId) ?? '',
        optionalString(body.reason),
      ));
    }
    throw new LeadLifecycleError(
      'action must be start, send, or stop.',
      'invalid_lead_action',
      400,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  try {
    const leadId = request.nextUrl.searchParams.get('leadId') ?? '';
    const afterRaw = request.nextUrl.searchParams.get('afterCursor');
    const waitRaw = request.nextUrl.searchParams.get('waitMs');
    const afterCursor = afterRaw === null ? 0 : Number(afterRaw);
    const waitMs = waitRaw === null ? 0 : Number(waitRaw);
    if ((afterRaw !== null && !/^\d+$/.test(afterRaw))
      || (waitRaw !== null && !/^\d+$/.test(waitRaw))
      || !Number.isSafeInteger(afterCursor) || afterCursor < 0
      || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000
    ) {
      throw new LeadLifecycleError(
        'afterCursor must be non-negative and waitMs must be from 0 to 30000.',
        'invalid_lead_wait',
        400,
      );
    }
    return json(waitMs > 0
      ? await waitForLead({ leadId, afterCursor, waitMs })
      : getLeadStatus(leadId, afterCursor));
  } catch (error) {
    return errorResponse(error);
  }
}
