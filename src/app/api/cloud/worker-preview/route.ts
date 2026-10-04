import { getSqlite } from '@/lib/db';
import { serviceSessionCurrent, workerClaimKeyCurrent } from '@/lib/cloud/review-service-authority';
import { NextResponse } from 'next/server';
import { setTimeout as delay } from 'node:timers/promises';

import { verifyCloudWorkerKey } from '@/lib/cloud/worker-auth';
import { getJob } from '@/lib/cloud/job-queue';
import { answerPreviewRequest, takePreviewRequest } from '@/lib/cloud/preview-relay';
import { PREVIEW_MAX_BYTES, type RemotePreviewResponse } from '@/lib/cloud/preview-contract';
import { readPreviewMessage } from '@/lib/cloud/preview-message';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

function authority(request: Request, value: Record<string, unknown>) {
  const auth = verifyCloudWorkerKey(request.headers.get('authorization'));
  if (!auth.ok) return NextResponse.json({ error: 'Worker authorization rejected.' }, { status: auth.status, headers });
  const jobId = typeof value.jobId === 'string' ? value.jobId : '';
  const job = getJob(auth.teamId, jobId);
  if (!workerClaimKeyCurrent(getSqlite(), jobId, auth.keyId)) return NextResponse.json({ error: 'Claim credential mismatch.' }, { status: 403, headers });
  const attempt = Number(value.attempt);
  if (!job || !Number.isSafeInteger(attempt) || attempt < 1 || job.claimCount !== attempt
    || job.claimedBy !== value.workerId || job.leaseToken !== value.leaseToken || job.status !== 'leased'
    || !serviceSessionCurrent(getSqlite(), { id: job.id, team_id: job.teamId, parent_job_id: job.parentJobId ?? null,
      packet_id: job.packetId ?? null, launch_json: JSON.stringify(job.launch), status: job.status })
    || Date.parse(job.leaseExpiresAt ?? '') <= Date.now() || !job.launch.remotePreview) {
    return NextResponse.json({ error: 'Current preview lease required.' }, { status: 409, headers });
  }
  return { teamId: auth.teamId, jobId, attempt };
}

export async function GET(request: Request) {
  const value = Object.fromEntries(new URL(request.url).searchParams);
  const deadline = Date.now() + 5_000;
  try {
    while (!request.signal.aborted) {
      const auth = authority(request, value);
      if (auth instanceof Response) return auth;
      const item = takePreviewRequest(auth.teamId, auth.jobId, auth.attempt);
      if (item) return NextResponse.json({ request: item }, { headers });
      if (Date.now() >= deadline) break;
      await delay(100, undefined, { signal: request.signal });
    }
    return new NextResponse(null, { status: 204, headers });
  } catch {
    return NextResponse.json({ error: 'Preview read unavailable.' }, { status: 503, headers });
  }
}

export async function POST(request: Request) {
  const auth = verifyCloudWorkerKey(request.headers.get('authorization'));
  if (!auth.ok) return NextResponse.json({ error: 'Worker authorization rejected.' }, { status: auth.status, headers });
  try {
    const value = await readPreviewMessage(request, PREVIEW_MAX_BYTES * 1.5 + 4_096);
    const auth = authority(request, value);
    if (auth instanceof Response) return auth;
    const result = value.result as RemotePreviewResponse | undefined;
    if (!result || typeof result.id !== 'string' || !answerPreviewRequest(auth.teamId, auth.jobId, auth.attempt, result)) {
      return NextResponse.json({ error: 'Preview response no longer belongs to this attempt.' }, { status: 409, headers });
    }
    return NextResponse.json({ ok: true }, { headers });
  } catch {
    return NextResponse.json({ error: 'Invalid preview response.' }, { status: 400, headers });
  }
}
