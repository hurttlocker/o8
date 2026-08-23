/**
 * #1112 — Build a minimal `OrchestratorPacket` from a `Lane` row when the
 * canonical mission state has been overwritten (a second `create_mission`
 * dropped the prior mission's packets out of the in-memory store).
 *
 * Same pattern as #1106 for governance READS — once you've reached for the
 * lane registry via `findLatestLaneByPacket`, the consumers that previously
 * required a real packet (audit metadata, review state derivation) just need
 * an object-shaped stub. This helper centralizes that synthesis so it stays
 * consistent across surfaces.
 *
 * Status/runtime/branch come from the lane. Everything else is a defensive
 * default — these stubs never get written back to mission state, they only
 * flow through audit + read paths.
 */
import type { Lane, LaneStatus } from '@/lib/lane/types';
import { packetStatusFromLaneStatus } from '@/lib/orchestrator/packet-state';
import type {
  OrchestratorPacket,
  OrchestratorPacketStatus,
  OrchestratorReleaseState,
} from '@/lib/orchestrator/types';

/**
 * #1476 doctrine — ONE canonical lane.status → packet.status mapping. This was
 * a third private copy (packet-state.ts and derive-review-state each had their
 * own); the copies disagreed on awaiting_human (this one fell to its
 * awaiting_review default instead of blocked). Everyone calls
 * packetStatusFromLaneStatus now; unknown lane statuses collapse to blocked so
 * they surface for attention rather than masquerading as review-ready.
 */
function laneStatusToPacketStatus(status: LaneStatus): OrchestratorPacketStatus {
  return packetStatusFromLaneStatus(status) ?? 'blocked';
}

export function synthesizePacketFromLane(packetId: string, lane: Lane): OrchestratorPacket {
  const status = laneStatusToPacketStatus(lane.status);
  const releaseState: OrchestratorReleaseState = status === 'released' ? 'released' : 'pending';
  return {
    id: packetId,
    referenceLabel: lane.label || packetId,
    title: lane.label || packetId,
    summary: '',
    workspaceTargetPath: lane.repoPath || null,
    branchTarget: lane.branch,
    runtime: lane.runtime,
    model: lane.model,
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'held',
    releaseState,
    status,
    lastEventAt: lane.lastEventAt,
    lastEventLabel: lane.lastEventLabel,
    // OrchestratorLaneBinding requires tileId/tabId which a lane row doesn't
    // carry — those are UI tile coordinates set at dispatch time and lost
    // when mission state was overwritten. Leaving `lane: null` here is fine:
    // callers that need lane data already have it directly (they passed it
    // in to look us up).
    lane: null,
  };
}
