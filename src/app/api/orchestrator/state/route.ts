import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  syncOrchestratorControlPlaneState,
  withLockedState,
} from '@/lib/orchestrator/control-plane';
import { buildDagMetadata } from '@/lib/orchestrator/dag';
import { currentLaneMergePolicy } from '@/lib/lane/dogfood-guard';
import { findLaneByPacket } from '@/lib/lane/registry';
import { packetStatusWriteRejection } from '@/lib/orchestrator/packet-patch-policy';
import { autoResolveMergedPacketVerificationIncidents } from '@/lib/supervisor/merged-incident-resolution';
import type {
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorStateApiErrorResponse,
  OrchestratorStateApiResponse,
} from '@/lib/orchestrator/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Enrich packets with live lane info from the lane registry. The persisted
// packet.lane field is rarely populated (lane bindings live in their own
// registry, not in the orchestrator state file), so without this pass the
// React-side mission state sees lane=null on every packet — which breaks
// the dashboard's tab-badge rebind, the orange "latest dispatch" marker,
// the WorkspaceChatPane live-status lookup, and anything else that needs
// lane.sessionKey to thread the in-flight session into the UI. The MCP
// path (operator-mission-service/mission.ts:294) already does the same
// merge; keeping the HTTP path in lockstep means dispatch flows look
// identical regardless of which surface launched the work.
function enrichMissionWithLanes(mission: OrchestratorMissionState): OrchestratorMissionState {
  // Merge policy (#1367) — this rebuild is the LAST shape the desktop provider
  // sees; dropping the policy here left the chat banner rendering a doomed
  // Approve & merge in PR-only mode (live-hit 2026-07-04).
  const mergePolicy = currentLaneMergePolicy();
  const packets = mission.packets.map((packet) => {
    const lane = findLaneByPacket(packet.id);
    if (!lane) return packet;
    return {
      ...packet,
      lane: {
        tileId: packet.lane?.tileId ?? '',
        tabId: packet.lane?.tabId ?? '',
        repoPath: lane.worktreePath ?? lane.repoPath ?? packet.lane?.repoPath ?? null,
        worktreePath: lane.worktreePath ?? packet.lane?.worktreePath ?? null,
        runtime: lane.runtime,
        sessionKey: lane.sessionKey,
        laneId: lane.id,
        lastHeartbeatAt: packet.lane?.lastHeartbeatAt ?? null,
        lastEventAt: lane.lastEventAt,
        lastEventLabel: lane.lastEventLabel,
        mergeMode: mergePolicy.mode,
        mergeModeNote: mergePolicy.note,
      },
    };
  });
  return { ...mission, packets };
}

function buildStateResponse(mission: OrchestratorMissionState): OrchestratorStateApiResponse {
  const enriched = enrichMissionWithLanes(mission);
  return {
    mission: enriched,
    dag: buildDagMetadata(enriched.packets),
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

/**
 * Atomic single-packet update. `cortex_update_packet` (MCP) previously read the
 * whole mission, mutated one packet client-side, and POSTed the entire packets
 * array back — racing concurrent packet edits (browser reconcile, other MCP
 * calls) and silently reverting their writes. PATCH applies a packet-level
 * delta INSIDE the control-plane lock so only the targeted fields change.
 * Mission-identity fields stay server-owned (see #596) and cannot be patched.
 */
export async function PATCH(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({})) as {
      packetId?: string;
      updates?: Record<string, unknown>;
    };
    const packetId = (body.packetId ?? '').trim();
    const updates = body.updates && typeof body.updates === 'object' ? body.updates : null;
    if (!packetId || !updates) {
      return buildErrorResponse('packetId and a non-empty updates object are required.', 400);
    }

    const statusRejection = packetStatusWriteRejection(updates);
    if (statusRejection) {
      return NextResponse.json(
        { error: statusRejection },
        {
          status: 422,
          headers: { 'Cache-Control': 'no-store, max-age=0' },
        },
      );
    }

    const FORBIDDEN_FIELDS = new Set(['id', 'missionId']);
    const { state: mission, result } = await withLockedState((current) => {
      const packet = current.packets.find((p) => p.id === packetId);
      if (!packet) return { found: false } as const;
      const mutablePacket = packet as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(updates)) {
        if (FORBIDDEN_FIELDS.has(key)) continue;
        mutablePacket[key] = value;
      }
      return { found: true } as const;
    });

    if (!result.found) return buildErrorResponse(`Packet ${packetId} not found.`, 404);
    if (typeof updates.archivedAt === 'string' && updates.archivedAt.trim()) {
      autoResolveMergedPacketVerificationIncidents({ packetId, event: 'packet_archived' });
    }

    return NextResponse.json(buildStateResponse(mission), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to patch packet.';
    return buildErrorResponse(message);
  }
}
