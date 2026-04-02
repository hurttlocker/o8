import { randomUUID } from 'node:crypto';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import type { LaneLifecycleEventPayload } from '@/lib/realtime/types';
import type { Lane, LaneStatus } from './types';

function generateLaneLifecycleMutationId(laneId: string) {
  return `lane-lifecycle-${laneId}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

function buildLaneLifecyclePayload(
  lane: Pick<Lane, 'id' | 'packetId' | 'status' | 'sessionKey' | 'branch' | 'repoPath'>,
  previousStatus: LaneStatus | null,
  timestamp: string,
): LaneLifecycleEventPayload {
  return {
    laneId: lane.id,
    packetId: lane.packetId,
    status: lane.status,
    previousStatus,
    sessionKey: lane.sessionKey,
    branch: lane.branch,
    repoPath: lane.repoPath,
    timestamp,
  };
}

export function publishLaneLifecycleEvent(
  lane: Pick<Lane, 'id' | 'packetId' | 'status' | 'sessionKey' | 'branch' | 'repoPath' | 'runtime' | 'label'>,
  previousStatus: LaneStatus | null,
  timestamp: string,
) {
  const payload = buildLaneLifecyclePayload(lane, previousStatus, timestamp);
  console.log(`[lane-lifecycle] ${payload.laneId} ${previousStatus ?? 'new'} -> ${payload.status}`);
  void publishRealtimeMutation({
    mutation: {
      mutationId: generateLaneLifecycleMutationId(payload.laneId),
      source: 'server',
      action: 'lane-lifecycle',
      status: 'completed',
      runtime: lane.runtime,
      surfaceId: payload.sessionKey ?? undefined,
      sessionKey: payload.sessionKey ?? undefined,
      laneId: payload.laneId,
      packetId: payload.packetId ?? undefined,
      repoPath: payload.repoPath,
      branch: payload.branch,
      laneStatus: payload.status,
      previousStatus: payload.previousStatus,
      timestamp: payload.timestamp,
      note: `${lane.label}: ${previousStatus ?? 'new'} -> ${payload.status}`,
      createdAt: payload.timestamp,
      settledAt: payload.timestamp,
    },
  });
}
