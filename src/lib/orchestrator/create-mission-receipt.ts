import 'server-only';

import { listRecentMissions } from '@/lib/db/missions-store';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';

export function findMissionByCreationMutationId(
  clientMutationId: string,
): OrchestratorMissionState | null {
  const current = readOrchestratorControlPlaneState();
  if (current.creationMutationId === clientMutationId && current.creationReceipt) return current;
  return listRecentMissions(100)
    .find((entry) => (
      entry.missionState?.creationMutationId === clientMutationId
      && entry.missionState.creationReceipt
    ))
    ?.missionState ?? null;
}
