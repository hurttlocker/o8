import { NextResponse, type NextRequest } from 'next/server';

import { dispatch } from '@/lib/lane/commands';
import { getLane } from '@/lib/lane/registry';
import { requirePanelAuth } from '@/lib/panel/auth';
import { listProjectLocks } from '@/lib/projects/locks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

interface LockActionBody {
  action?: unknown;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ laneId: string }> },
) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const { laneId } = await params;
  const body = (await req.json().catch(() => ({}))) as LockActionBody;
  const action = typeof body.action === 'string' ? body.action.trim() : 'archive_stale';
  if (action !== 'archive_stale') {
    return NextResponse.json({ error: 'Unsupported lock action.' }, { status: 400, headers: NO_STORE });
  }

  const lane = getLane(laneId);
  if (!lane) {
    return NextResponse.json({ error: 'Lane not found.' }, { status: 404, headers: NO_STORE });
  }

  const lock = (await listProjectLocks()).find((candidate) => candidate.laneId === laneId);
  if (!lock) {
    return NextResponse.json({ error: 'Project lock not found.' }, { status: 404, headers: NO_STORE });
  }
  if (!lock.stale && lane.status !== 'failed') {
    return NextResponse.json(
      { error: 'Only stale or failed locks can be archived from Projects.' },
      { status: 409, headers: NO_STORE },
    );
  }

  const result = await dispatch({ verb: 'archive', laneId, actor: 'user' });
  if (!result.ok) {
    return NextResponse.json({ error: result.note }, { status: 422, headers: NO_STORE });
  }

  return NextResponse.json({ ok: true, lane: result.lane }, { headers: NO_STORE });
}
