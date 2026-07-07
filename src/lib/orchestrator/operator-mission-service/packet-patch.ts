import { writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { currentMissionState } from './shared';

/**
 * Shallow-merge a patch onto a single mission packet and persist through the
 * control-plane write chokepoint (same pattern as {@link submitPacketReview}).
 * Returns false when the packet is not in mission state — an orphan/lane-only
 * packet is a no-op, mirroring submitPacketReview's missionPacket guard.
 *
 * Used by the review pipeline to stamp packet-scoped review artifacts
 * (deviations #1490, explainer #1491) that the surfaces read back.
 */
export function patchMissionPacket(packetId: string, patch: Partial<OrchestratorPacket>): boolean {
  const state = currentMissionState();
  if (!state.packets.some((candidate) => candidate.id === packetId)) {
    return false;
  }
  writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState({
    ...state,
    packets: state.packets.map((candidate) => candidate.id === packetId
      ? { ...candidate, ...patch }
      : candidate),
  }));
  return true;
}
