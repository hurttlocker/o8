import { randomUUID } from 'node:crypto';
import { recordLaneEvent } from '@/lib/orchestrator/runtime-status';
import { notifyReviewReady } from '@/lib/push/notify';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import type { LaneLifecycleEventPayload } from '@/lib/realtime/types';
import type { Lane, LaneStatus } from './types';

function generateLaneLifecycleMutationId(laneId: string) {
  return `lane-lifecycle-${laneId}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

// NOTE: lane status is exposed as `status` here; clients coalesce laneStatus ?? status (see laneStatusOf).
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
  // #619 — Sibling effect: record into the MCP-facing ring buffer so agents
  // can long-poll lane transitions without racing the WS broadcast loop.
  try {
    recordLaneEvent(payload);
  } catch (err) {
    console.error(`[lane-lifecycle] recordLaneEvent failed: ${err}`);
  }
  // Pipeline root fix (2026-07-03) — the review-ready edge notifies the
  // operator's devices. This chokepoint already feeds the MCP ring buffer and
  // the lane-lifecycle WS channel; the push was the missing third leg, so an
  // away operator never heard that review-ready work existed and stale lanes
  // aged unseen into reaper territory.
  if (payload.status === 'reviewing' && previousStatus !== 'reviewing') {
    notifyReviewReady({
      laneId: payload.laneId,
      label: lane.label,
      packetId: payload.packetId,
      repoPath: payload.repoPath,
    });
  }
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
