import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  syncOrchestratorControlPlaneState,
  withLockedState,
} from '@/lib/orchestrator/control-plane';
import { buildDagMetadata } from '@/lib/orchestrator/dag';
import type {
  OrchestratorMissionState,
  OrchestratorPacket,
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

/**
 * #596 — Mission-identity guard. The browser caches the last-loaded mission
 * and periodically POSTs it back after client-side reconciles. When MCP
 * (or any other server-side actor) creates a NEW mission, the browser's
 * next POST arrives with the STALE missionId and clobbers the fresh
 * pointer.
 *
 * Rule: mission identity (`missionId`, `prompt`, `summary`, `repoPath`,
 * `runtime`, `constraints`) is server-owned. Only the server-side
 * createMission / dispatchMission / review / merge paths are allowed to
 * change these. The POST endpoint (driven by the browser) can only update
 * PACKET-LEVEL fields within the mission whose identity currently matches
 * what the server holds.
 *
 * When the incoming missionId doesn't match the server's current mission,
 * the POST is treated as stale: the stale body is dropped and the server's
 * current state is returned unchanged. The comparison runs inside the
 * control-plane lock so a createMission landing between our read and our
 * write can't be clobbered.
 */
function mergeClientMissionUnderLock(
  incoming: OrchestratorMissionState,
  current: OrchestratorMissionState,
): OrchestratorMissionState | null {
  const serverMissionId = (current.missionId ?? '').trim();
  const incomingMissionId = (incoming.missionId ?? '').trim();

  if (serverMissionId && incomingMissionId !== serverMissionId) {
    console.warn(
      `[orchestrator-state] POST dropped stale client mission `
      + `(client=${incomingMissionId || 'empty'}, server=${serverMissionId}). `
      + `Client will re-hydrate on next load.`,
    );
    return null;
  }

  // Identity matches (or server has no mission yet): accept the body,
  // but pin identity fields to the server's values so a client that
  // synthesized partial state can't overwrite them to empty/different
  // strings. Packet-level updates flow through as-is.
  const packets: OrchestratorPacket[] = Array.isArray(incoming.packets) ? incoming.packets : [];
  return {
    ...incoming,
    missionId: current.missionId || incoming.missionId,
    prompt: current.prompt || incoming.prompt,
    summary: current.summary || incoming.summary,
    repoPath: current.repoPath ?? incoming.repoPath,
    runtime: current.runtime || incoming.runtime,
    constraints: current.constraints ?? incoming.constraints,
    packets,
  };
}

export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({})) as { mission?: OrchestratorMissionState };
    const incoming = body.mission;

    if (!incoming) {
      // No payload — fall back to the existing "reconcile current" behavior.
      const mission = await syncOrchestratorControlPlaneState();
      return NextResponse.json(buildStateResponse(mission), {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    // Do the mission-identity compare inside the control-plane lock so a
    // concurrent createMission (MCP path) landing between our read and
    // our write can't be clobbered. If the client is stale, drop the body
    // and just return the server's current state.
    const { state: mission } = await withLockedState((current) => {
      const merged = mergeClientMissionUnderLock(incoming, current);
      if (!merged) return { dropped: true } as const;

      // Replace the in-lock state with the merged body so the post-callback
      // reconcile persists it. Preserve the `current` object identity so
      // the reconcile/write in withLockedState uses the mutated fields.
      Object.assign(current, merged);
      return { dropped: false } as const;
    });

    return NextResponse.json(buildStateResponse(mission), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update orchestrator state.';
    return buildErrorResponse(message);
  }
}
