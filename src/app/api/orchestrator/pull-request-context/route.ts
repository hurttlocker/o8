import { NextRequest } from 'next/server';

import { resolveRequestPrincipal } from '@/lib/auth/principal';
import {
  attachPullRequestContext,
  listPullRequestContext,
  PullRequestContextError,
  unlinkPullRequestContext,
  type PullRequestContextIdentity,
} from '@/lib/orchestrator/pull-request-context';
import { operatorError, operatorSuccess } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function requireOperator(request: NextRequest): Response | null {
  return resolveRequestPrincipal(request) === 'operator' ? null
    : operatorError('forbidden', 'Conversation PR context is operator-only.', 403);
}

function invalid(): Response {
  return operatorError('invalid_request', 'Provide a conversation or complete GitHub PR identity, with valid pagination.', 400);
}

function threadId(value: unknown): string | null {
  return typeof value === 'string' && /^thoughts-[A-Za-z0-9_-]{1,120}$/.test(value) ? value : null;
}

function positiveId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function identity(body: Record<string, unknown>): PullRequestContextIdentity | null {
  const repositoryId = positiveId(body.repositoryId);
  const pullRequestId = positiveId(body.pullRequestId);
  const number = positiveId(body.number);
  return body.host === 'github.com' && repositoryId && pullRequestId && number
    ? { host: 'github.com', repositoryId, pullRequestId, number } : null;
}

function failure(error: unknown): Response {
  return error instanceof PullRequestContextError
    ? operatorError(error.code, error.message, error.status)
    : operatorError('context_unavailable', 'Unable to access conversation PR context.', 500);
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const denied = requireOperator(request);
    if (denied) return denied;
    const params = request.nextUrl.searchParams;
    const hasThread = params.has('threadId');
    const prFields = ['host', 'repositoryId', 'pullRequestId', 'number'];
    if (hasThread && prFields.some(key => params.has(key))) return invalid();
    const targetThread = hasThread ? threadId(params.get('threadId')) : null;
    if (hasThread && !targetThread) return invalid();
    const target = targetThread ? { threadId: targetThread }
      : identity({ host: params.get('host'), repositoryId: Number(params.get('repositoryId')),
        pullRequestId: Number(params.get('pullRequestId')), number: Number(params.get('number')) });
    if (!target) return invalid();
    return operatorSuccess(listPullRequestContext(target, {
      ...(params.has('after') ? { after: Number(params.get('after')) } : {}),
      ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
    }));
  } catch (error) { return failure(error); }
}

async function mutate(request: NextRequest, remove: boolean): Promise<Response> {
  try {
    const denied = requireOperator(request);
    if (denied) return denied;
    const text = await request.text();
    if (text.length > 8_192) return invalid();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return invalid(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid();
    const body = parsed as Record<string, unknown>;
    const targetThread = threadId(body.threadId);
    const targetPr = identity(body);
    if (!targetThread || !targetPr) return invalid();
    if (remove) return operatorSuccess({ removed: unlinkPullRequestContext(targetThread, targetPr) });
    const result = attachPullRequestContext(targetThread, targetPr);
    return operatorSuccess(result, result.created ? 201 : 200);
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest): Promise<Response> { return mutate(request, false); }
export async function DELETE(request: NextRequest): Promise<Response> { return mutate(request, true); }
