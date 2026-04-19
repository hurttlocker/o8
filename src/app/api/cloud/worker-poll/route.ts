/**
 * Cloud worker long-poll endpoint (issue #514 v0 scaffolding)
 *
 * Workers hit this endpoint with a cursor:
 *   GET /api/cloud/worker-poll?cursor=0&workerId=<opaque>
 *   Authorization: Bearer <cwk_...>
 *
 * The server holds the request open up to `LONG_POLL_TIMEOUT_MS`. If a job is
 * available at or after the presented cursor, it responds with the job. If
 * the timeout fires first, it returns 204 so the worker can re-poll cheaply.
 *
 * Why a separate auth path from `/api/panel/*`?
 *   The panel middleware (src/middleware.ts) gates on loopback origin + the
 *   ~/.cortex-ide/ws-token bearer — that token is per-user, loopback-only,
 *   and must never leave the operator's machine. Cloud workers run OFF-host
 *   (Kubernetes, VMs, customer bare metal) so they need a different tier of
 *   credential with team scoping. `/api/cloud/*` is therefore added to
 *   middleware.WORKER_PREFIXES which bypasses panel-auth; this handler then
 *   runs its own verifyCloudWorkerKey() check against config-file records.
 */
import { NextResponse } from 'next/server';
import { buildErrorPayload } from '@/lib/api/error-format';
import { verifyCloudWorkerKey } from '@/lib/cloud/worker-auth';
import { claimNextJob, waitForJob } from '@/lib/cloud/job-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };
const LONG_POLL_TIMEOUT_MS = 25_000;

function authErrorResponse(status: 401 | 403, reason: string) {
  return NextResponse.json(
    { error: status === 401 ? 'Unauthorized' : 'Forbidden', reason },
    { status, headers: NO_STORE_HEADERS },
  );
}

export async function GET(request: Request) {
  const auth = verifyCloudWorkerKey(request.headers.get('authorization'));
  if (!auth.ok) {
    return authErrorResponse(auth.status, auth.reason);
  }

  const url = new URL(request.url);
  const cursorParam = url.searchParams.get('cursor');
  const workerIdParam = url.searchParams.get('workerId');
  const cursor = cursorParam ? Number.parseInt(cursorParam, 10) : 0;
  const workerId = workerIdParam?.trim() || auth.keyId;

  if (!Number.isFinite(cursor) || cursor < 0) {
    return NextResponse.json(
      { error: 'Invalid cursor', reason: 'cursor_out_of_range' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    // Fast path — job already waiting for this cursor.
    const immediate = claimNextJob(auth.teamId, cursor, workerId);
    if (immediate) {
      return NextResponse.json(
        {
          job: {
            id: immediate.id,
            cursor: immediate.cursor,
            launch: immediate.launch,
            enqueuedAt: immediate.enqueuedAt,
            claimedAt: immediate.claimedAt,
          },
        },
        { headers: NO_STORE_HEADERS },
      );
    }

    // Slow path — long-poll until a job arrives or timeout.
    // The AbortSignal on the incoming request fires when the worker hangs
    // up early; in that case we cancel the waiter so we don't leak memory.
    const waiter = waitForJob(auth.teamId, LONG_POLL_TIMEOUT_MS);
    const abort = request.signal;
    if (abort.aborted) {
      waiter.cancel();
      return new NextResponse(null, { status: 499, headers: NO_STORE_HEADERS });
    }
    const onAbort = () => waiter.cancel();
    abort.addEventListener('abort', onAbort);

    try {
      const job = await waiter.promise;
      if (!job) {
        return new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS });
      }
      return NextResponse.json(
        {
          job: {
            id: job.id,
            cursor: job.cursor,
            launch: job.launch,
            enqueuedAt: job.enqueuedAt,
            claimedAt: job.claimedAt,
          },
        },
        { headers: NO_STORE_HEADERS },
      );
    } finally {
      abort.removeEventListener('abort', onAbort);
    }
  } catch (error) {
    console.error('[cloud-worker-poll] failed:', error);
    return NextResponse.json(
      buildErrorPayload('cloud_worker_poll_failed'),
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
