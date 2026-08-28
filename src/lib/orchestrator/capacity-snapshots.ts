import { recordLaneEvent } from '@/lib/lane/events';
import { getLaneEvents } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import type { RuntimeCapacitySnapshot } from '@/lib/runtimes/types';

export type PacketCapacitySnapshotPhase = 'start' | 'end';

function unavailable(runtime: string, reason: string): RuntimeCapacitySnapshot {
  return {
    runtime,
    identityId: null,
    status: 'unavailable',
    reason,
    observedAt: null,
    source: null,
    confidence: null,
    buckets: [],
  };
}

export async function capturePacketCapacitySnapshot(
  lane: Lane,
  phase: PacketCapacitySnapshotPhase,
): Promise<void> {
  if (!lane.packetId) return;
  const sessionKey = lane.sessionKey?.trim() || null;
  const alreadyCaptured = getLaneEvents(lane.id, 10_000).some((event) => (
    event.verb === 'capacity_snapshot'
      && event.payload.phase === phase
      && event.payload.sessionKey === sessionKey
  ));
  if (alreadyCaptured) return;

  let capacity: RuntimeCapacitySnapshot;
  try {
    const { getRuntimeCapacityControlSnapshot } = await import('@/lib/runtime/capacity-service');
    const control = await getRuntimeCapacityControlSnapshot({ fresh: true });
    capacity = control.capacities.find((candidate) => (
      candidate.runtime === lane.runtime && candidate.identityId === null
    )) ?? control.capacities.find((candidate) => candidate.runtime === lane.runtime)
      ?? unavailable(lane.runtime, 'adapter_observation_unavailable');
  } catch {
    capacity = unavailable(lane.runtime, 'capacity_service_failed');
  }

  try {
    recordLaneEvent(lane.id, 'capacity_snapshot', 'system', {
      phase,
      packetId: lane.packetId,
      sessionKey,
      capturedAt: new Date().toISOString(),
      ...capacity,
    });
  } catch (error) {
    console.warn(
      `[capacity-snapshot] failed to persist ${phase} snapshot for lane ${lane.id}:`,
      error instanceof Error ? error.message : error,
    );
  }
}
