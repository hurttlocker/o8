import { NextResponse } from 'next/server';

import { beginJobDrain, finishJobDrain, getJobDrainStatus } from '@/lib/cloud/job-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TEAM_ID = 'team_default';
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET() {
  return NextResponse.json(
    { ok: true, drain: getJobDrainStatus(TEAM_ID) },
    { headers: NO_STORE_HEADERS },
  );
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { finalize?: unknown } | null;
  if (body !== null && (typeof body !== 'object' || Array.isArray(body))) {
    return NextResponse.json(
      { error: 'Request body must be a JSON object' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  if (body?.finalize !== undefined && typeof body.finalize !== 'boolean') {
    return NextResponse.json(
      { error: 'finalize must be boolean' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const drain = body?.finalize === true ? finishJobDrain(TEAM_ID) : beginJobDrain(TEAM_ID);
  return NextResponse.json({ ok: true, drain }, { headers: NO_STORE_HEADERS });
}
