import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { findLaneByPacket } from '@/lib/lane/registry';

import type { MergePacketResult } from './operator-mission-service';

// #557 — Orchestrator-chat dispatches sometimes create a lane with a packetId
// that never got registered in missionState (auto-attach race). Lane table is
// the durable source of truth, so when approve_and_merge receives a packetId
// missing from mission state, we fall through to a direct lane merge instead
// of throwing "Packet not found." Governance is enforced at the commands.ts
// merge chokepoint: a durable approved orchestrator_review row must match the
// current worktree HEAD, otherwise this path creates an operator card.
export async function mergeOrphanLaneByPacket(
  packetId: string,
  commitMessage: string | undefined,
  expectedHeadSha?: string,
): Promise<MergePacketResult> {
  const orphanLane = findLaneByPacket(packetId);
  if (!orphanLane) {
    throw new Error(`Packet ${packetId} not found — no mission packet and no lane.`);
  }

  console.log(
    `[mcp-operator] approve_and_merge: packet ${packetId} not in mission state — merging via lane ${orphanLane.id} directly.`,
  );
  const result = await dispatchLaneCommand({
    verb: 'merge',
    laneId: orphanLane.id,
    commitMessage: commitMessage?.trim() || undefined,
    expectedHeadSha: expectedHeadSha?.trim() || undefined,
    actor: 'orchestrator',
  });
  // #1110 follow-up — same mergedClean backfill as the in-mission merge path
  // in operator-mission-service/merge.ts. Orphan-lane merges hit a packet that
  // session_outcomes did capture at completion time; backfill here closes the
  // loop for that subset too. Fire-and-forget — never fail the merge over it.
  if (result.ok) {
    void import('./context-relay').then(({ markOutcomeMerged }) =>
      markOutcomeMerged({ laneId: orphanLane.id, packetId }),
    ).catch((err) => {
      console.warn(`[session-outcome-merge] orphan-path mergedClean backfill failed for packet ${packetId}:`, err);
    });
  }
  return {
    merged: result.ok,
    note: result.ok
      ? `${result.note} (merged via lane fallback — packet ${packetId} was not in mission state)`
      : result.note,
    ...(result.approvalId ? { approvalId: result.approvalId } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.expectedHeadSha ? { expectedHeadSha: result.expectedHeadSha } : {}),
    ...(result.reviewedHeadSha ? { reviewedHeadSha: result.reviewedHeadSha } : {}),
    ...(result.currentHeadSha ? { currentHeadSha: result.currentHeadSha } : {}),
  };
}
