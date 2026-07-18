/**
 * GET /api/orchestrator/review-state?packetId=<id>
 *
 * Returns the canonical review state for a single packet — the read-path
 * behind the `o8_review_state` MCP tool (#621).
 *
 * Combines:
 *   - packet state from the mission service
 *   - lane state from the lane registry
 *   - most-recent orchestrator review verdict from `packet.review`
 *   - current merge-gate verdict from `runMergeGate(lane)` (best-effort;
 *     the gate is computed on-demand — it reads the diff so it requires
 *     a lane with a worktree)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { listApprovalsForContext } from '@/lib/approvals/store';
import type { ApprovalRecord } from '@/lib/approvals/types';
import { findLatestLaneByPacket, findLaneBySession, getLaneEvents } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { buildPreviewForLane, type MergePreviewResult } from '@/lib/lane/preview-merge';
import {
  derivePacketReviewState,
  type DeriveReviewStateMergeGate,
  type DeriveReviewStateOrchestratorReview,
} from '@/lib/orchestrator/derive-review-state';
import { syncOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { synthesizePacketFromLane } from '@/lib/orchestrator/synthesize-packet';
import { requirePanelAuth } from '@/lib/panel/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOG_PREFIX = '[review-state]';
const JSON_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

function errorResponse(code: string, message: string, status = 500) {
  return NextResponse.json({ error: { code, message } }, { status, headers: JSON_HEADERS });
}

function toOrchestratorReview(review: {
  approved: boolean;
  summary: string;
  recordedAt: string;
} | null | undefined): DeriveReviewStateOrchestratorReview | null {
  if (!review) return null;
  return {
    verdict: review.approved ? 'approved' : 'rejected',
    ts: review.recordedAt,
    summary: review.summary,
  };
}

function approvalReviewedAt(approval: ApprovalRecord): string {
  const ts = approval.resolvedAt ?? approval.updatedAt ?? approval.createdAt;
  return new Date(ts).toISOString();
}

function toDurableOrchestratorReview(packetId: string, lane: Lane | null): DeriveReviewStateOrchestratorReview | null {
  const approval = listApprovalsForContext({
    packetId,
    laneId: lane?.id,
    sessionKey: lane?.sessionKey ?? undefined,
  }).find((candidate) =>
    candidate.toolName === 'orchestrator_review'
    && (candidate.status === 'approved' || candidate.status === 'rejected')
  );

  if (!approval) return null;
  const approved = typeof approval.args?.approved === 'boolean'
    ? approval.args.approved
    : approval.status === 'approved';
  return {
    verdict: approved ? 'approved' : 'rejected',
    ts: approvalReviewedAt(approval),
    summary: approval.description || approval.summary || '',
  };
}

// #1476 lie 3b — the gate is recomputed on every poll, so its timestamp must
// be "when could this last have changed" (the lane's latest event), never
// now(). Stamping now() made stateChangedAt track poll cadence (~60s bumps
// all session) instead of actual transitions.
function toMergeGate(
  preview: MergePreviewResult | null,
  lastChangedAt: string | null,
): DeriveReviewStateMergeGate | null {
  if (!preview) return null;
  return {
    verdict: preview.wouldMerge ? 'passing' : 'failing',
    ts: lastChangedAt ?? new Date(0).toISOString(),
    checks: preview.checks.map((check) => check.name),
    diffBase: preview.diffBase,
  };
}

// #1476 lie 3a — final verdict fallback: the append-only review_recorded lane
// event. Mission state is an in-memory singleton (evicted by the next
// create_mission) and the approvals lookup is score-based (misses when the
// lane's sessionKey detaches mid-merge); lane events are keyed by lane id
// alone and never mutated, so a recorded verdict is always recoverable here.
function toLaneEventOrchestratorReview(lane: Lane | null): DeriveReviewStateOrchestratorReview | null {
  if (!lane) return null;
  const events = getLaneEvents(lane.id);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.verb !== 'review_recorded') continue;
    const payload = (event.payload ?? {}) as { approved?: unknown; summary?: unknown };
    if (typeof payload.approved !== 'boolean') continue;
    return {
      verdict: payload.approved ? 'approved' : 'rejected',
      ts: event.timestamp,
      summary: typeof payload.summary === 'string' ? payload.summary : '',
    };
  }
  return null;
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  let packetId = request.nextUrl.searchParams.get('packetId')?.trim() ?? '';
  // sessionKey fallback — a detached packet (dropped from mission state after its
  // worker finished) has no client-resolvable packetId, but the tab always knows
  // its lane sessionKey. Resolve packetId server-side so the decision banner works
  // for detached/parked packets (Q ruling 2026-07-11). Same fallback pattern as
  // packet-transcript (#1389).
  const sessionKey = request.nextUrl.searchParams.get('sessionKey')?.trim() ?? '';
  if (!packetId && sessionKey) {
    const laneBySession = findLaneBySession(sessionKey);
    if (laneBySession?.packetId) packetId = laneBySession.packetId;
  }
  if (!packetId) {
    return errorResponse('invalid_request', 'packetId or sessionKey query parameter is required.', 400);
  }

  try {
    const mission = await syncOrchestratorControlPlaneState();
    const lane = findLatestLaneByPacket(packetId);

    // #1112 — Mission state is an in-memory singleton that gets overwritten
    // by each new `create_mission`, so packets from a prior mission lose
    // their entry even though the lane is alive. Fall through to the lane
    // registry (same pattern as #1106) and synthesize a minimal packet stub
    // so review-state still surfaces something useful. Only 404 if neither
    // mission state nor the lane registry knows about the packet.
    const missionPacket = mission.packets.find((candidate) => candidate.id === packetId);
    if (!missionPacket && !lane) {
      return errorResponse('packet_not_found', `Packet ${packetId} not found.`, 404);
    }
    const packet = missionPacket ?? synthesizePacketFromLane(packetId, lane!);

    // Merge preview is computed on-demand from the lane's diff. If the lane is
    // gone (archived / never spawned) we can't run the gate — fall back to
    // null and let the derivation treat it as unwired. This uses the same
    // preview shape as the review card/CLI so dirty worktrees are re-checked at
    // read time, not only when the review transition first fired.
    let mergePreview: MergePreviewResult | null = null;
    if (lane) {
      try {
        mergePreview = await buildPreviewForLane(lane, packetId, {
          orchestratorApproved: packet.review?.approved === true,
        });
      } catch (error) {
        console.warn(`${LOG_PREFIX} buildPreviewForLane failed for packet ${packetId}:`, error);
        mergePreview = null;
      }
    }

    const orchestratorReview = toOrchestratorReview(packet.review ?? null)
      ?? toDurableOrchestratorReview(packetId, lane)
      ?? toLaneEventOrchestratorReview(lane);
    const mergeGate = toMergeGate(mergePreview, lane?.lastEventAt ?? packet.lastEventAt ?? null);

    const { state, stateChangedAt } = derivePacketReviewState({
      packet,
      lane,
      orchestratorReview,
      mergeGate,
    });

    return NextResponse.json({
      packetId,
      state,
      stateChangedAt,
      orchestratorReview,
      mergeGate,
      lane: lane?.id ?? null,
      branch: lane?.branch ?? packet.branchTarget ?? null,
      // Title so a detached packet's decision banner can name itself instead of
      // falling back to a generic "Dispatched packet".
      title: packet.title ?? lane?.label ?? null,
      outcome: lane?.outcome ?? null,
      outcomeNote: lane?.outcomeNote ?? null,
    }, { headers: JSON_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read review state.';
    console.error(`${LOG_PREFIX} failed for packet ${packetId}: ${message}`);
    return errorResponse('review_state_failed', message);
  }
}
