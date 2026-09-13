import { NextResponse } from 'next/server';

import {
  getAppUpdateState,
  setAppUpdateState,
  type AppUpdateCheckOutcome,
} from '@/lib/app-update/relaunch-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const CHECK_OUTCOMES = new Set<AppUpdateCheckOutcome>(['never', 'available', 'current', 'failed']);
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

function invalidState(code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status: 400, headers: NO_STORE_HEADERS });
}

export async function GET() {
  return NextResponse.json({ ok: true, state: getAppUpdateState() }, { headers: NO_STORE_HEADERS });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!isRecord(body) || typeof body.updatePending !== 'boolean') {
    return invalidState('invalid_update_pending', 'updatePending must be boolean.');
  }
  if (typeof body.checkOutcome !== 'string' || !CHECK_OUTCOMES.has(body.checkOutcome as AppUpdateCheckOutcome)) {
    return invalidState('invalid_check_outcome', 'checkOutcome must be never, available, current, or failed.');
  }
  const checkOutcome = body.checkOutcome as AppUpdateCheckOutcome;
  if (checkOutcome === 'available' && !body.updatePending) {
    return invalidState('invalid_update_state', 'available requires updatePending to be true.');
  }
  if ((checkOutcome === 'never' || checkOutcome === 'current') && body.updatePending) {
    return invalidState('invalid_update_state', `${checkOutcome} requires updatePending to be false.`);
  }
  if (checkOutcome !== 'never'
    && (typeof body.checkedAt !== 'string' || !body.checkedAt.trim() || !Number.isFinite(Date.parse(body.checkedAt)))) {
    return invalidState('invalid_checked_at', 'checkedAt must be an ISO timestamp after a check runs.');
  }

  const state = setAppUpdateState({
    updatePending: body.updatePending,
    version: typeof body.version === 'string' && body.version.trim() ? body.version.trim() : null,
    checkOutcome,
    checkedAt: typeof body.checkedAt === 'string' ? body.checkedAt : null,
    checkError: typeof body.checkError === 'string' ? body.checkError : null,
  });
  return NextResponse.json({ ok: true, state }, { headers: NO_STORE_HEADERS });
}
