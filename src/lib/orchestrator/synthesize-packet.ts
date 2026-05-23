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
import type {
  OrchestratorPacket,
  OrchestratorPacketStatus,
  OrchestratorReleaseState,
} from '@/lib/orchestrator/types';

/**
 * Conservative lane.status → packet.status mapping. Lane states that don't
 * have a direct packet equivalent collapse to the closest review-pipeline
 * concept (paused/awaiting_* → blocked; merging → awaiting_review).
 */
function laneStatusToPacketStatus(status: LaneStatus): OrchestratorPacketStatus {
  switch (status) {
    case 'idle':
      return 'idle';
    case 'launching':
      return 'launching';
    case 'running':
      return 'running';
    case 'paused':
      return 'idle';
    case 'awaiting_input':
    case 'awaiting_orchestrator':
      return 'blocked';
    case 'recovering':
      return 'recovering';
    case 'reviewing':
    case 'merging':
      return 'awaiting_review';
    case 'failed':
      return 'failed';
    case 'completed':
      return 'released';
    case 'archived':
      return 'archived';
    default:
      return 'awaiting_review';
  }
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
