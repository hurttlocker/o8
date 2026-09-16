import type { OrchestratorMissionState } from '@/lib/orchestrator/types';

/**
 * Packet ids present in `previous` but absent from `next`: a client-side
 * delete. The mission POST names these explicitly because the server never
 * treats a packet missing from a client snapshot as deleted (#2351).
 */
export function removedOrchestratorPacketIds(
  previous: OrchestratorMissionState,
  next: OrchestratorMissionState,
): string[] {
  const kept = new Set(next.packets.map((packet) => packet.id));
  return previous.packets.map((packet) => packet.id).filter((id) => !kept.has(id));
}
