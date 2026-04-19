import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { findLaneByPacket } from '@/lib/lane/registry';
import {
  buildComparisonCommentary,
  collectPacketDiff,
  type ComparisonPacketDiff,
} from '@/lib/orchestrator/comparison-meta';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/orchestrator/comparison-meta { groupId }
 *
 * Returns side-by-side commentary for a completed best-of-n group. Always
 * returns something renderable — falls back to a heuristic when no
 * ANTHROPIC_API_KEY is configured.
 */
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const groupId = typeof record.groupId === 'string' ? record.groupId.trim() : '';
  if (!groupId) {
    return operatorError('invalid_request', 'groupId is required.', 400);
  }

  try {
    const state = readOrchestratorControlPlaneState();
    const packets = state.packets.filter((packet) => packet.comparisonGroupId === groupId);
    if (packets.length === 0) {
      return operatorError('not_found', `No packets found for comparison group ${groupId}.`, 404);
    }

    const diffs: ComparisonPacketDiff[] = [];
    for (const packet of packets) {
      const lane = packet.lane?.laneId ? findLaneByPacket(packet.id) : null;
      const baseBranch = lane?.baseBranch ?? null;
      const diff = await collectPacketDiff(packet, baseBranch);
      if (diff) {
        diffs.push(diff);
      }
    }

    const commentary = await buildComparisonCommentary(groupId, diffs);
    return operatorSuccess(commentary);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to build comparison commentary.';
    return operatorError('comparison_meta_failed', message, 500, error);
  }
}
