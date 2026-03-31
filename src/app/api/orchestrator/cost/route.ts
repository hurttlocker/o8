import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { aggregateMissionCost } from '@/lib/orchestrator/cost-aggregator';
import {
  readOrchestratorControlPlaneState,
  syncOrchestratorControlPlaneState,
} from '@/lib/orchestrator/control-plane';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonResponse(payload: { cost: Awaited<ReturnType<typeof aggregateMissionCost>> }) {
  return NextResponse.json(payload, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  try {
    const mission = await syncOrchestratorControlPlaneState(readOrchestratorControlPlaneState());
    const cost = await aggregateMissionCost(mission);
    return jsonResponse({ cost });
  } catch (error) {
    console.error('[cost-agg] GET failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Cost aggregation failed' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({})) as { mission?: OrchestratorMissionState };
    const mission = body.mission
      ? normalizeOrchestratorMissionState(body.mission)
      : await syncOrchestratorControlPlaneState(readOrchestratorControlPlaneState());
    const cost = await aggregateMissionCost(mission);
    return jsonResponse({ cost });
  } catch (error) {
    console.error('[cost-agg] POST failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Cost aggregation failed' }, { status: 500 });
  }
}
