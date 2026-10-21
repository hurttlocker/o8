import { getSqlite } from '@/lib/db';
import { workerClaimKeyCurrent } from '@/lib/cloud/review-service-authority';
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
import { appendJobEvent, getJob } from '@/lib/cloud/job-queue';
import { recordCloudWorkerPresence } from '@/lib/cloud/worker-presence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

type StreamEventType = 'chunk' | 'diff' | 'service' | 'completed' | 'errored' | 'heartbeat';
const STREAM_EVENT_TYPES = new Set<StreamEventType>(['chunk', 'diff', 'service', 'completed', 'errored', 'heartbeat']);

function isStreamEventType(value: unknown): value is StreamEventType {
  return typeof value === 'string' && STREAM_EVENT_TYPES.has(value as StreamEventType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isDiffPayload(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.files)) return false;
  return value.files.every((file) => (
    isRecord(file)
    && typeof file.path === 'string'
    && ['added', 'modified', 'deleted', 'renamed'].includes(String(file.status))
    && Number.isInteger(file.additions)
    && Number(file.additions) >= 0
    && Number.isInteger(file.deletions)
    && Number(file.deletions) >= 0
    && (file.originalPath === undefined || typeof file.originalPath === 'string')
  ));
}

function isServicePayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.name === 'string' && value.name.trim().length > 0
    && value.name.length <= 64 && !/[\x00-\x1f\x7f]/.test(value.name)
    && (value.state === 'healthy' || value.state === 'stopped' || value.state === 'failed')
    && typeof value.commandId === 'string' && /^[a-f0-9]{64}$/.test(value.commandId)
    && typeof value.manifestHash === 'string' && /^[a-f0-9]{64}$/.test(value.manifestHash)
    && Number.isInteger(value.claimCount) && Number(value.claimCount) > 0
    && (value.port === null || (Number.isInteger(value.port) && Number(value.port) > 0 && Number(value.port) <= 65_535))
    && (value.health === undefined || (typeof value.health === 'boolean'));
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
  if (type === 'diff' && !isDiffPayload(body.payload)) {
    return badRequest('Invalid diff payload');
  }
  if (type === 'service' && !isServicePayload(body.payload)) {
    return badRequest('Invalid service payload');
  }

  try {
    if (!workerClaimKeyCurrent(getSqlite(), jobId, auth.keyId)) return authErrorResponse(403, 'claim_credential_mismatch');
    if (type === 'service' && isRecord(body.payload)) {
      const job = getJob(auth.teamId, jobId);
      if (!job || job.claimCount !== body.payload.claimCount
        || job.launch.remoteManifestHash !== body.payload.manifestHash) {
        return badRequest('Service receipt does not match the current job attempt');
      }
    }
    const result = appendJobEvent({
      teamId: auth.teamId,
      jobId,
      workerId,
      leaseToken,
      type,
      // Service credentials are recorded by the coordinator, never trusted
      // from a worker payload. Preview grants can then honor key revocation.
      payload: type === 'service' && isRecord(body.payload) ? { ...body.payload, workerKeyId: auth.keyId } : body.payload,
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

    recordCloudWorkerPresence({ teamId: auth.teamId, keyId: auth.keyId, workerId });

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
