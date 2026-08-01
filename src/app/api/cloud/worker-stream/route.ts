/**
 * Cloud worker stream endpoint (issue #514 v0 scaffolding)
 *
 * Workers POST transcript chunks + lifecycle events to this endpoint:
 *   POST /api/cloud/worker-stream
 *   Authorization: Bearer <cwk_...>
 *   Body: { jobId: string, type: 'chunk'|'completed'|'errored', payload: ... }
 *
 * V0 is write-only persistence — chunks are accepted, job status transitions
 * are enforced (terminal states cannot regress), and subscribers (the
 * adapter's readTranscript path) will read from the durable log once the
 * worker CLI is shipped.
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
import { getJob, setJobStatus } from '@/lib/cloud/job-queue';

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
  const type = body.type;
  if (!jobId || !isStreamEventType(type) || !('payload' in body)) {
    return badRequest('Invalid stream payload');
  }

  try {
    const job = getJob(auth.teamId, jobId);
    if (!job) {
      // Either the job belongs to a different team or it was never enqueued.
      // Either way, from this worker's perspective it doesn't exist.
      return authErrorResponse(403, 'job_not_found_or_wrong_team');
    }

    // TODO(#514-followup): persist the chunk to disk/DB so readTranscript can
    // replay it. For v0 we accept the write and update lifecycle state only,
    // which keeps the contract stable for the worker CLI without committing
    // to a storage shape yet.
    switch (type) {
      case 'chunk':
      case 'heartbeat':
        // No-op persistence in v0. The worker CLI can start POSTing chunks
        // now — they'll be accepted by the server, and the persistence layer
        // is a separate issue that doesn't change this contract.
        break;
      case 'completed':
        setJobStatus(auth.teamId, jobId, 'completed');
        break;
      case 'errored':
        setJobStatus(auth.teamId, jobId, 'errored');
        break;
    }

    return NextResponse.json(
      { ok: true, jobId, accepted: type },
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
