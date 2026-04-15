import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  readOrchestratorControlPlaneState,
  syncOrchestratorControlPlaneState,
} from '@/lib/orchestrator/control-plane';
import { buildDagMetadata } from '@/lib/orchestrator/dag';
import type {
  OrchestratorMissionState,
  OrchestratorStateApiErrorResponse,
  OrchestratorStateApiResponse,
} from '@/lib/orchestrator/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function buildStateResponse(mission: OrchestratorMissionState): OrchestratorStateApiResponse {
  return {
    mission,
    dag: buildDagMetadata(mission.packets),
  };
}

function buildErrorResponse(message: string, status = 500) {
  const payload: OrchestratorStateApiErrorResponse = {
    error: {
      code: 'orchestrator_state_failed',
      message,
    },
  };

  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  try {
    // Pass undefined so sync re-reads inside the mutex — reading outside the
    // lock and then passing the snapshot in races against concurrent writers
    // (e.g. /api/orchestrator/delegate's packet synthesis) whose writes land
    // between our read and the lock acquisition. undefined → reconcile reads
    // fresh state inside the lock.
    const mission = await syncOrchestratorControlPlaneState();
    return NextResponse.json(buildStateResponse(mission), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read orchestrator state.';
    return buildErrorResponse(message);
  }
}

export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({})) as { mission?: OrchestratorMissionState };
    const mission = await syncOrchestratorControlPlaneState(body.mission ?? readOrchestratorControlPlaneState());

    return NextResponse.json(buildStateResponse(mission), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update orchestrator state.';
    return buildErrorResponse(message);
  }
}
