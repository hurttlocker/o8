import { updateLane } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { readOrchestratorControlPlaneState, withLockedState } from '@/lib/orchestrator/control-plane';
import { withMissionRegistryState } from '@/lib/orchestrator/mission-registry';
import { resolvePacketLaunchContext } from '@/lib/orchestrator/packet-launch-context';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export const READ_ONLY_COMPLETED_EVENT_LABEL = 'read_only_completed';

function markPacketCompleted(packet: OrchestratorPacket, completedAt: string, lane: Lane): void {
  packet.status = 'released';
  packet.queueState = 'held';
  packet.releaseState = 'released';
  packet.releaseStatePayload = {
    ...(packet.releaseStatePayload ?? {}),
    releasedAt: completedAt,
    source: READ_ONLY_COMPLETED_EVENT_LABEL,
  };
  packet.blockedReason = null;
  packet.lastEventAt = completedAt;
  packet.lastEventLabel = READ_ONLY_COMPLETED_EVENT_LABEL;
  if (packet.lane) {
    packet.lane = {
      ...packet.lane,
      laneId: lane.id,
      sessionKey: lane.sessionKey ?? packet.lane.sessionKey ?? null,
      lastEventAt: completedAt,
      lastEventLabel: READ_ONLY_COMPLETED_EVENT_LABEL,
    };
  }
}

export async function completeReadOnlyZeroDiffLane(
  lane: Lane,
): Promise<{ completed: boolean; lane?: Lane }> {
  const packetId = lane.packetId?.trim();
  if (!packetId) return { completed: false };

  const resolved = resolvePacketLaunchContext(packetId);
  if (resolved?.launchContext.workMode !== 'read-only') return { completed: false };

  const completedAt = new Date().toISOString();
  const completedLane = updateLane(lane.id, {
    status: 'completed',
    outcome: 'no_changes',
    outcomeNote: 'Read-only inspection completed without repository changes.',
    lastEventAt: completedAt,
    lastEventLabel: READ_ONLY_COMPLETED_EVENT_LABEL,
  }, 'system') ?? lane;

  const current = readOrchestratorControlPlaneState();
  if (current.packets.some((packet) => packet.id === packetId)) {
    await withLockedState((state) => {
      const packet = state.packets.find((candidate) => candidate.id === packetId);
      if (packet) markPacketCompleted(packet, completedAt, completedLane);
    });
  }

  if (resolved.missionId) {
    try {
      await withMissionRegistryState(resolved.missionId, (state) => {
        const packet = state.packets.find((candidate) => candidate.id === packetId);
        if (packet) markPacketCompleted(packet, completedAt, completedLane);
        return { state, result: null };
      });
    } catch (error) {
      console.warn(`[read-only-completion] Failed to update mission ${resolved.missionId}:`, error);
    }
  }

  return { completed: true, lane: completedLane };
}
