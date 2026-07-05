import { NextResponse } from 'next/server';

import { setAppUpdateState } from '@/lib/app-update/relaunch-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!isRecord(body) || typeof body.updatePending !== 'boolean') {
    return NextResponse.json({ error: 'updatePending must be boolean.' }, { status: 400 });
  }

  const state = setAppUpdateState({
    updatePending: body.updatePending,
    version: typeof body.version === 'string' && body.version.trim() ? body.version.trim() : null,
  });
  return NextResponse.json({ ok: true, state }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
