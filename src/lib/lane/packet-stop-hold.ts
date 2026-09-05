import {
  readOrchestratorControlPlaneState,
  withLockedState,
} from '@/lib/orchestrator/control-plane';
import {
  findMissionRegistryEntryByPacketId,
  withMissionRegistryState,
} from '@/lib/orchestrator/mission-registry';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

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
  if (packet.operatorStopped || packet.queueState === 'held') {
    return { allowed: false, reason: 'packet_held', status: packet.status };
  }
  if (packet.releaseState === 'released' || MANAGED_RUN_TERMINAL_PACKET_STATUSES.has(packet.status)) {
    return { allowed: false, reason: 'packet_terminal', status: packet.status };
  }
  return { allowed: true, reason: 'active', status: packet.status };
}

/** Read the durable packet state before admitting a packet-bound managed run. */
export function inspectPacketManagedRunAdmission(packetId: string): PacketManagedRunAdmission {
  const normalizedPacketId = packetId.trim();
  if (!normalizedPacketId) {
    return { allowed: false, reason: 'packet_not_found', status: null };
  }
  const currentPacket = readOrchestratorControlPlaneState().packets
    .find((candidate) => candidate.id === normalizedPacketId) ?? null;
  if (currentPacket) return managedRunAdmissionForPacket(currentPacket);

  const registryPacket = findMissionRegistryEntryByPacketId(normalizedPacketId, { includeArchived: true })
    ?.mission.packets.find((candidate) => candidate.id === normalizedPacketId) ?? null;
  return managedRunAdmissionForPacket(registryPacket);
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
