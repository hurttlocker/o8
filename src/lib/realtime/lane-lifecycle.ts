import type { LaneLifecycleEventPayload, RealtimeMutationRecord } from './types';

export function mutationToLaneLifecyclePayload(
  mutation: RealtimeMutationRecord,
): LaneLifecycleEventPayload | null {
  if (mutation.action !== 'lane-lifecycle') return null;
  if (!mutation.laneId || !mutation.laneStatus || !mutation.branch || !mutation.repoPath || !mutation.timestamp) {
    return null;
  }

  return {
    laneId: mutation.laneId,
    packetId: mutation.packetId ?? null,
    status: mutation.laneStatus,
    label: mutation.laneLabel,
    outcome: mutation.laneOutcome,
    runtime: mutation.runtime,
    previousStatus: mutation.previousStatus ?? null,
    sessionKey: mutation.sessionKey ?? null,
    branch: mutation.branch,
    repoPath: mutation.repoPath,
    timestamp: mutation.timestamp,
  };
}
