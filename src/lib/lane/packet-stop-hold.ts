import {
  readOrchestratorControlPlaneState,
  withLockedState,
} from '@/lib/orchestrator/control-plane';
import {
  findMissionRegistryEntryByPacketId,
  withMissionRegistryState,
} from '@/lib/orchestrator/mission-registry';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { hasCanonicalReleaseEvidence } from '@/lib/orchestrator/packet-release-truth';
import { getSqlite } from '@/lib/db';
import { findLaneByPacket } from './registry';

export interface PacketManagedRunAdmission {
  allowed: boolean;
  reason: 'active' | 'packet_not_found' | 'packet_held' | 'packet_terminal';
  status: OrchestratorPacket['status'] | null;
}

const MANAGED_RUN_TERMINAL_PACKET_STATUSES = new Set<OrchestratorPacket['status']>([
  'awaiting_review',
  'failed',
  'blocked',
  'released',
  'archived',
]);

function applyOperatorHold(packet: OrchestratorPacket) {
  packet.operatorStopped = true;
  packet.queueState = 'held';
  packet.status = 'blocked';
  packet.blockedReason = 'operator_stopped';
  packet.lastEventAt = new Date().toISOString();
  packet.lastEventLabel = 'operator_stopped';
}

function managedRunAdmissionForPacket(packet: OrchestratorPacket | null): PacketManagedRunAdmission {
  if (!packet) return { allowed: false, reason: 'packet_not_found', status: null };
  if (packet.operatorStopped) {
    return { allowed: false, reason: 'packet_held', status: packet.status };
  }
  const steeredRun = acceptedSteerRunState(packet.id);
  if (!packetSteerHoldReason(packet.id) && steeredRun === 'active') {
    return { allowed: true, reason: 'active', status: 'running' };
  }
  if (steeredRun === 'closed') {
    return { allowed: false, reason: 'packet_terminal', status: packet.status };
  }
  if (packet.queueState === 'held') {
    return { allowed: false, reason: 'packet_held', status: packet.status };
  }
  if (packet.releaseState === 'released' || MANAGED_RUN_TERMINAL_PACKET_STATUSES.has(packet.status)) {
    return { allowed: false, reason: 'packet_terminal', status: packet.status };
  }
  return { allowed: true, reason: 'active', status: packet.status };
}

/** Read the durable packet state before admitting a packet-bound managed run. */
function readManagedRunPacket(packetId: string): OrchestratorPacket | null {
  const normalizedPacketId = packetId.trim();
  if (!normalizedPacketId) return null;
  const currentPacket = readOrchestratorControlPlaneState().packets
    .find((candidate) => candidate.id === normalizedPacketId) ?? null;
  if (currentPacket) return currentPacket;

  const registryPacket = findMissionRegistryEntryByPacketId(normalizedPacketId, { includeArchived: true })
    ?.mission.packets.find((candidate) => candidate.id === normalizedPacketId) ?? null;
  return registryPacket;
}

/** A steer is not authority to undo an operator stop, archive, or proven release. */
export function packetSteerHoldReason(packetId: string): string | null {
  const packet = readManagedRunPacket(packetId);
  if (packet?.operatorStopped) return 'operator_stopped';
  if (packet?.archivedAt || packet?.status === 'archived') return 'archived';
  if (packet?.releaseState === 'released' && hasCanonicalReleaseEvidence(packet)) return 'released';
  return null;
}

function acceptedSteerRunState(packetId: string): 'absent' | 'active' | 'closed' {
  const lane = findLaneByPacket(packetId);
  if (!lane?.sessionKey) return 'absent';
  const grant = getSqlite().prepare(`
    SELECT id, payload_json FROM lane_events
    WHERE lane_id = ? AND verb = 'steer_run_admitted'
    ORDER BY timestamp DESC, rowid DESC LIMIT 1
  `).get(lane.id) as { id: string; payload_json: string } | undefined;
  if (!grant) return 'absent';
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(grant.payload_json) as Record<string, unknown>; }
  catch { return 'closed'; }
  if (!payload || typeof payload !== 'object') return 'closed';
  if (payload.packetId !== packetId || payload.sessionKey !== lane.sessionKey) return 'absent';
  if (lane.status !== 'running') return 'closed';
  // Query only lifecycle evidence, not the last N transcript/tool events. A
  // long turn must not lose admission merely because it produced more output.
  const event = getSqlite().prepare(`
    SELECT id FROM lane_events
    WHERE lane_id = ? AND verb IN (
      'steer_run_admitted', 'steered_packet', 'steer_failed',
      'runtime_process_exit', 'status_change'
    ) ORDER BY timestamp DESC, rowid DESC LIMIT 1
  `).get(lane.id) as { id: string } | undefined;
  if (event?.id !== grant.id || typeof payload.steerEventId !== 'string') return 'closed';
  const intent = getSqlite().prepare(`
    SELECT rowid FROM lane_events WHERE id = ? AND lane_id = ? AND verb = 'steered_packet'
  `).get(payload.steerEventId, lane.id) as { rowid: number } | undefined;
  if (!intent) return 'closed';
  // An immediate exit can precede the accepted-steer response. Insertion order
  // keeps equal-millisecond events distinct, including across a database reopen.
  const exited = getSqlite().prepare(`
    SELECT 1 FROM lane_events WHERE lane_id = ? AND verb = 'runtime_process_exit'
    AND rowid > ? LIMIT 1
  `).get(lane.id, intent.rowid);
  return exited ? 'closed' : 'active';
}

export function inspectPacketManagedRunAdmission(packetId: string): PacketManagedRunAdmission {
  return managedRunAdmissionForPacket(readManagedRunPacket(packetId));
}

/** Persist the lane stop guard in whichever durable mission store owns it. */
export async function persistLanePacketHold(packetId: string): Promise<boolean> {
  let currentFound = false;
  await withLockedState((state) => {
    const packet = state.packets.find((candidate) => candidate.id === packetId);
    if (!packet) return;
    currentFound = true;
    applyOperatorHold(packet);
  });
  if (currentFound) return true;

  const entry = findMissionRegistryEntryByPacketId(packetId, { includeArchived: true });
  if (!entry) return false;
  const { result } = await withMissionRegistryState(entry.id, (state) => {
    const packet = state.packets.find((candidate) => candidate.id === packetId);
    if (!packet) return { state, result: false };
    applyOperatorHold(packet);
    return { state, result: true };
  });
  return result;
}
