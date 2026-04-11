import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { runHeadlessSprintTick } from '@/lib/orchestrator/headless-loop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({})) as { releasePacketIds?: unknown };
  const releasePacketIds = Array.isArray(body.releasePacketIds)
    ? body.releasePacketIds
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
    : undefined;

  try {
    const result = await runHeadlessSprintTick({ releasePacketIds });
    return NextResponse.json({
      ok: true,
      launched: result.launched,
      active: result.active,
      currentWave: result.currentWave,
      totalWaves: result.totalWaves,
    }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to run headless tick',
    }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }
}
