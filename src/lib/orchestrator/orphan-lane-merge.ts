import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { findLaneByPacket } from '@/lib/lane/registry';

import type { MergePacketResult } from './operator-mission-service';

// #557 — Orchestrator-chat dispatches sometimes create a lane with a packetId
// that never got registered in missionState (auto-attach race). Lane table is
// the durable source of truth, so when approve_and_merge receives a packetId
// missing from mission state, we fall through to a direct lane merge instead
// of throwing "Packet not found." Approval audit still fires via
// dispatchLaneCommand so governance semantics are preserved.
export async function mergeOrphanLaneByPacket(
  packetId: string,
  commitMessage: string | undefined,
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
    orchestratorReviewed: true,
    actor: 'orchestrator',
  });
  return {
    merged: result.ok,
    note: result.ok
      ? `${result.note} (merged via lane fallback — packet ${packetId} was not in mission state)`
      : result.note,
    ...(result.approvalId ? { approvalId: result.approvalId } : {}),
  };
}
