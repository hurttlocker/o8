import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';

/** Normalize durable mission state while removing read-time status projections. */
export function normalizeOrchestratorMissionStateForPersistence(
  raw: unknown,
): OrchestratorMissionState {
  const normalized = normalizeOrchestratorMissionState(raw);
  return {
    ...normalized,
    packets: normalized.packets.map((packet) => {
      if (!packet.statusEvidence) return packet;
      const persisted = { ...packet };
      delete persisted.statusEvidence;
      return persisted;
    }),
  };
}
