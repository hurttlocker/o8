import { NextResponse } from 'next/server';

import { verifyCloudWorkerKey } from '@/lib/cloud/worker-auth';
import { acknowledgeJobControl, claimJobControl } from '@/lib/cloud/job-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

function authError(status: 401 | 403, reason: string) {
  return NextResponse.json(
    { error: status === 401 ? 'Unauthorized' : 'Forbidden', reason },
    { status, headers: NO_STORE_HEADERS },
  );
}

function rejected(reason: string, status?: string) {
  return NextResponse.json(
    { error: 'Cloud job control rejected', reason, status },
    { status: reason === 'job_not_found' ? 403 : 409, headers: NO_STORE_HEADERS },
  );
}

export async function GET(request: Request) {
  const auth = verifyCloudWorkerKey(request.headers.get('authorization'));
  if (!auth.ok) return authError(auth.status, auth.reason);
  const url = new URL(request.url);
  const jobId = url.searchParams.get('jobId')?.trim();
  const workerId = url.searchParams.get('workerId')?.trim() || auth.keyId;
  const leaseToken = url.searchParams.get('leaseToken')?.trim();
  if (!jobId || !leaseToken) {
    return NextResponse.json(
      { error: 'jobId and leaseToken are required' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const result = claimJobControl({
    teamId: auth.teamId,
    jobId,
    workerId,
    leaseToken,
  });
  if (!result.accepted) return rejected(result.reason, result.job?.status);
  if (!result.control) return new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS });
  return NextResponse.json({ control: result.control }, { headers: NO_STORE_HEADERS });
}

export async function POST(request: Request) {
  const auth = verifyCloudWorkerKey(request.headers.get('authorization'));
  if (!auth.ok) return authError(auth.status, auth.reason);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const jobId = typeof body?.jobId === 'string' ? body.jobId.trim() : '';
  const workerId = typeof body?.workerId === 'string' && body.workerId.trim()
    ? body.workerId.trim()
    : auth.keyId;
  const leaseToken = typeof body?.leaseToken === 'string' ? body.leaseToken.trim() : '';
  const controlId = typeof body?.controlId === 'string' ? body.controlId.trim() : '';
  const deliveryToken = typeof body?.deliveryToken === 'string' ? body.deliveryToken.trim() : '';
  if (!jobId || !leaseToken || !controlId || !deliveryToken) {
    return NextResponse.json(
      { error: 'jobId, leaseToken, controlId, and deliveryToken are required' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const result = acknowledgeJobControl({
    teamId: auth.teamId,
    jobId,
    workerId,
    leaseToken,
    controlId,
    deliveryToken,
  });
  if (!result.accepted) return rejected(result.reason, result.job?.status);
  return NextResponse.json({
    ok: true,
    control: result.control,
    status: result.job.status,
  }, { headers: NO_STORE_HEADERS });
}
