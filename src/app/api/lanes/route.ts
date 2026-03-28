import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { listLanes, listActiveLanes } from '@/lib/lane/registry';
import { dispatch } from '@/lib/lane/commands';
import type { LaneCommand } from '@/lib/lane/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const activeOnly = url.searchParams.get('active') !== 'false';

  const lanes = activeOnly ? listActiveLanes() : listLanes();

  return NextResponse.json({ lanes }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const body = await req.json().catch(() => null) as LaneCommand | null;
  if (!body || !body.verb) {
    return NextResponse.json({ ok: false, note: 'Missing command verb.' }, { status: 400 });
  }

  try {
    const result = await dispatch(body);
    return NextResponse.json(result, {
      status: result.ok ? 200 : 422,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Command failed.';
    return NextResponse.json({ ok: false, note: message }, { status: 500 });
  }
}
