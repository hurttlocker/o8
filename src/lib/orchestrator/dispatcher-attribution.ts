import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { PacketDispatcherAttribution } from '@/lib/orchestrator/types';

export interface ResolvedPacketDispatcher {
  dispatcher: PacketDispatcherAttribution;
  missionId: string | null;
}

export function resolvePacketDispatcher(packetId: string): ResolvedPacketDispatcher | null {
  const normalizedPacketId = packetId.trim();
  if (!normalizedPacketId) return null;

  const current = normalizeOrchestratorMissionState(readOrchestratorControlPlaneState());
  const currentPacket = current.packets.find((packet) => packet.id === normalizedPacketId);
  if (currentPacket?.dispatcher) {
    return { dispatcher: currentPacket.dispatcher, missionId: current.missionId?.trim() || null };
  }
  if (currentPacket?.orchestratorThreadId?.trim()) {
    return {
      dispatcher: { surface: 'orchestrator', id: currentPacket.orchestratorThreadId.trim() },
      missionId: current.missionId?.trim() || null,
    };
  }

  const registryEntry = findMissionRegistryEntryByPacketId(normalizedPacketId, { includeArchived: true });
  const registryPacket = registryEntry?.mission.packets.find((packet) => packet.id === normalizedPacketId);
  if (registryPacket?.dispatcher) {
    return { dispatcher: registryPacket.dispatcher, missionId: registryEntry?.id ?? null };
  }
  if (registryPacket?.orchestratorThreadId?.trim()) {
    return {
      dispatcher: { surface: 'orchestrator', id: registryPacket.orchestratorThreadId.trim() },
      missionId: registryEntry?.id ?? null,
    };
  }
  return null;
}
