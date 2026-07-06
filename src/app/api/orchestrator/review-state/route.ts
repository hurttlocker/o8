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
import { findLatestLaneByPacket } from '@/lib/lane/registry';
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

function toMergeGate(preview: MergePreviewResult | null): DeriveReviewStateMergeGate | null {
  if (!preview) return null;
  return {
    verdict: preview.wouldMerge ? 'passing' : 'failing',
    ts: new Date().toISOString(),
    checks: preview.checks.map((check) => check.name),
    diffBase: preview.diffBase,
  };
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const packetId = request.nextUrl.searchParams.get('packetId')?.trim() ?? '';
  if (!packetId) {
    return errorResponse('invalid_request', 'packetId query parameter is required.', 400);
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

    const orchestratorReview = toOrchestratorReview(packet.review ?? null);
    const mergeGate = toMergeGate(mergePreview);

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
    }, { headers: JSON_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read review state.';
    console.error(`${LOG_PREFIX} failed for packet ${packetId}: ${message}`);
    return errorResponse('review_state_failed', message);
  }
}
