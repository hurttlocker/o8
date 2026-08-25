/**
 * Cloud worker stream endpoint
 *
 * Workers POST transcript chunks + lifecycle events to this endpoint:
 *   POST /api/cloud/worker-stream
 *   Authorization: Bearer <cwk_...>
 *   Body: { jobId, workerId, leaseToken, type, payload }
 *
 * Every accepted event is appended to SQLite in order. The worker identity
 * and unexpired lease token gate output and terminal transitions.
 *
 * Why not use `/api/worker/event` which already exists?
 *   The existing /api/worker/* routes are bound to the push-based
 *   `remote-customer` adapter and a different SQLite schema (`worker_runs`,
 *   `worker_events`). This long-poll model is intentionally a
 *   separate tier so the two can evolve independently. DB schema unification
 *   is a follow-up decision, not a v0 task.
 */
import { NextResponse } from 'next/server';
import { buildErrorPayload } from '@/lib/api/error-format';
import { verifyCloudWorkerKey } from '@/lib/cloud/worker-auth';
import { appendJobEvent } from '@/lib/cloud/job-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

type StreamEventType = 'chunk' | 'completed' | 'errored' | 'heartbeat';
const STREAM_EVENT_TYPES = new Set<StreamEventType>(['chunk', 'completed', 'errored', 'heartbeat']);

function isStreamEventType(value: unknown): value is StreamEventType {
  return typeof value === 'string' && STREAM_EVENT_TYPES.has(value as StreamEventType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function authErrorResponse(status: 401 | 403, reason: string) {
  return NextResponse.json(
    { error: status === 401 ? 'Unauthorized' : 'Forbidden', reason },
    { status, headers: NO_STORE_HEADERS },
  );
}

function badRequest(message: string) {
  return NextResponse.json(
    { error: message },
    { status: 400, headers: NO_STORE_HEADERS },
  );
}

export async function POST(request: Request) {
  const auth = verifyCloudWorkerKey(request.headers.get('authorization'));
  if (!auth.ok) {
    return authErrorResponse(auth.status, auth.reason);
  }

  const body = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return badRequest('Invalid request body');
  }

  const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
  const leaseToken = typeof body.leaseToken === 'string' ? body.leaseToken.trim() : '';
  const workerId = typeof body.workerId === 'string' && body.workerId.trim()
    ? body.workerId.trim()
    : auth.keyId;
  const type = body.type;
  if (!jobId || !leaseToken || !isStreamEventType(type) || !('payload' in body)) {
    return badRequest('Invalid stream payload');
  }

  try {
    const result = appendJobEvent({
      teamId: auth.teamId,
      jobId,
      workerId,
      leaseToken,
      type,
      payload: body.payload,
    });
    if (!result.accepted && result.reason === 'job_not_found') {
      // Either the job belongs to a different team or it was never enqueued.
      // Either way, from this worker's perspective it doesn't exist.
      return authErrorResponse(403, 'job_not_found_or_wrong_team');
    }
    if (!result.accepted) {
      return NextResponse.json(
        {
          error: 'Cloud job lease rejected',
          reason: result.reason,
          status: result.job?.status,
        },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        jobId,
        accepted: type,
        eventId: result.eventId,
        status: result.job.status,
        leaseExpiresAt: result.job.leaseExpiresAt,
        executionAttempts: result.job.executionAttempts,
        maxAttempts: result.job.maxAttempts,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error('[cloud-worker-stream] failed:', error);
    return NextResponse.json(
      buildErrorPayload('cloud_worker_stream_failed'),
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
