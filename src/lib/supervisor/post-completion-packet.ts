import { withLockedState } from '@/lib/orchestrator/control-plane';
import { appendEvent, getLane, setLaneStatus, updateLane } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';

export interface PostCompletionPacketSnapshot {
  attemptCount: number;
  maxAttempts: number;
  referenceLabel: string;
  title: string;
}

export interface ResolvedPostCompletionPacket {
  packetId: string;
  snapshot: PostCompletionPacketSnapshot;
}

function normalizePacketId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function packetIdCandidates(laneId: string, payloadPacketId: string | null | undefined): string[] {
  const persistedLanePacketId = normalizePacketId(getLane(laneId)?.packetId);
  return [...new Set([
    normalizePacketId(payloadPacketId),
    persistedLanePacketId,
  ].filter((packetId): packetId is string => packetId !== null))];
}

export async function resolvePostCompletionPacket(
  laneId: string,
  payloadPacketId: string | null | undefined,
): Promise<ResolvedPostCompletionPacket | null> {
  const candidates = packetIdCandidates(laneId, payloadPacketId);
  if (candidates.length === 0) return null;

  const { result } = await withLockedState((state) => {
    for (const packetId of candidates) {
      const packet = state.packets.find((candidate) => candidate.id === packetId);
      if (!packet) continue;
      return {
        packetId,
        snapshot: {
          attemptCount: packet.attemptCount ?? 0,
          maxAttempts: packet.maxAttempts ?? 3,
          referenceLabel: packet.referenceLabel,
          title: packet.title,
        },
      } satisfies ResolvedPostCompletionPacket;
    }
    return null;
  });

  return result;
}

export function markRalphRetryRequeued(
  laneId: string,
  payloadPacketId: string | null | undefined,
): { lane: Lane; packetId: string } {
  const lane = getLane(laneId);
  if (!lane) {
    throw new Error(`Cannot requeue bounded retry: lane ${laneId} was not found.`);
  }

  const lanePacketId = normalizePacketId(lane.packetId);
  const candidatePacketId = normalizePacketId(payloadPacketId);
  if (lanePacketId && candidatePacketId && lanePacketId !== candidatePacketId) {
    appendEvent(laneId, 'update', 'system', {
      lastEventLabel: 'ralph_retry_requeue_packet_mismatch',
      packetId: candidatePacketId,
      lanePacketId,
    });
    throw new Error(
      `Cannot requeue bounded retry: lane ${laneId} belongs to packet ${lanePacketId}, not ${candidatePacketId}.`,
    );
  }

  const packetId = lanePacketId ?? candidatePacketId;
  if (!packetId) {
    appendEvent(laneId, 'update', 'system', {
      lastEventLabel: 'ralph_retry_requeue_packet_missing',
      packetId: null,
    });
    throw new Error(`Cannot requeue bounded retry: lane ${laneId} has no packet binding.`);
  }

  const updated = updateLane(
    laneId,
    {
      packetId,
      lastEventAt: new Date().toISOString(),
      lastEventLabel: 'ralph_retry_requeued',
    },
    'system',
    { packetId },
  );
  if (!updated) {
    throw new Error(`Cannot requeue bounded retry: lane ${laneId} disappeared during the update.`);
  }

  return { lane: updated, packetId };
}

export function transitionPostCompletionLaneToReviewing(
  laneId: string,
  payloadPacketId: string | null | undefined,
): { lane: Lane | null; packetId: string | null } {
  const packetId = packetIdCandidates(laneId, payloadPacketId)[0] ?? null;
  const lane = setLaneStatus(laneId, 'reviewing', 'system', 'agent_completed');
  return { lane, packetId };
}
