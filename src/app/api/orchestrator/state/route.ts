import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  readOrchestratorControlPlaneState,
  syncOrchestratorControlPlaneState,
} from '@/lib/orchestrator/control-plane';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const mission = await syncOrchestratorControlPlaneState(readOrchestratorControlPlaneState());
  return NextResponse.json({ mission }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const body = await req.json().catch(() => ({})) as { mission?: OrchestratorMissionState };
  const mission = await syncOrchestratorControlPlaneState(body.mission ?? readOrchestratorControlPlaneState());

  return NextResponse.json({ mission }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
