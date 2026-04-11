import { NextRequest, NextResponse } from 'next/server';
import { getLane } from '@/lib/lane/registry';
import { requirePanelAuth } from '@/lib/panel/auth';
import { startReviewQueueDrain, triggerAutoReview } from '@/lib/lane/auto-review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let reviewDrainStarted = false;

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({})) as { action?: unknown; laneId?: unknown };
  const action = typeof body.action === 'string' ? body.action : '';

  if (action === 'start') {
    if (!reviewDrainStarted) {
      startReviewQueueDrain();
      reviewDrainStarted = true;
    }
    return NextResponse.json({ ok: true }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }

  if (action === 'enqueue') {
    const laneId = typeof body.laneId === 'string' ? body.laneId.trim() : '';
    if (!laneId) {
      return NextResponse.json({ ok: false, error: 'laneId is required' }, { status: 400 });
    }

    const lane = getLane(laneId);
    if (!lane) {
      return NextResponse.json({ ok: false, error: 'Lane not found' }, { status: 404 });
    }

    triggerAutoReview(lane);
    return NextResponse.json({ ok: true }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }

  return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
}
