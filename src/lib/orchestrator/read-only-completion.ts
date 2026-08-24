import { updateLane } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { readOrchestratorControlPlaneState, withLockedState } from '@/lib/orchestrator/control-plane';
import { withMissionRegistryState } from '@/lib/orchestrator/mission-registry';
import { resolvePacketLaunchContext } from '@/lib/orchestrator/packet-launch-context';
import { markPacketReleased } from '@/lib/orchestrator/packet-release-truth';
import type { OrchestratorPacket, PacketContext } from '@/lib/orchestrator/types';

export const READ_ONLY_COMPLETED_EVENT_LABEL = 'read_only_completed';

function markPacketCompleted(packet: OrchestratorPacket, completedAt: string, lane: Lane): void {
  markPacketReleased(packet, {
    source: READ_ONLY_COMPLETED_EVENT_LABEL,
    evidenceKind: 'read_only_no_merge_required',
    releasedAt: completedAt,
  });
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

function markPacketEvidenceMissing(packet: OrchestratorPacket, failedAt: string, lane: Lane): void {
  packet.status = 'failed';
  packet.queueState = 'held';
  packet.blockedReason = 'read_only_evidence_missing';
  packet.lastEventAt = failedAt;
  packet.lastEventLabel = 'read_only_evidence_missing';
  if (packet.lane) {
    packet.lane = {
      ...packet.lane,
      laneId: lane.id,
      sessionKey: lane.sessionKey ?? packet.lane.sessionKey ?? null,
      lastEventAt: failedAt,
      lastEventLabel: 'read_only_evidence_missing',
    };
  }
}

export function hasCompleteReadOnlyReceipt(context: PacketContext | null | undefined): boolean {
  const review = context?.selfReview;
  return review?.passed === true
    && review.decision === 'finding_ready'
    && Boolean(review.outcome?.trim())
    && Boolean(review.evidence?.some((entry) => entry.trim()))
    && Boolean(review.residual?.trim());
}

export async function captureSettledReadOnlyCompletionContext(
  capture: () => Promise<PacketContext>,
  options: { attempts?: number; settleMs?: number } = {},
): Promise<PacketContext> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 4));
  const settleMs = Math.max(0, Math.floor(options.settleMs ?? 750));
  let context = await capture();

  for (let attempt = 1; attempt < attempts && !hasCompleteReadOnlyReceipt(context); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    context = await capture();
  }

  return context;
}

export interface ReadOnlyCompletionResult {
  completed: boolean;
  blocked?: boolean;
  detail?: string;
  lane?: Lane;
}

export function isReadOnlyPacketLane(lane: Lane): boolean {
  const packetId = lane.packetId?.trim();
  if (!packetId) return false;
  return resolvePacketLaunchContext(packetId)?.launchContext.workMode === 'read-only';
}

export async function completeReadOnlyZeroDiffLane(
  lane: Lane,
  context?: PacketContext | null,
): Promise<ReadOnlyCompletionResult> {
  const packetId = lane.packetId?.trim();
  if (!packetId) return { completed: false };

  const resolved = resolvePacketLaunchContext(packetId);
  if (!isReadOnlyPacketLane(lane) || !resolved) return { completed: false };

  const completedAt = new Date().toISOString();
  if (!hasCompleteReadOnlyReceipt(context)) {
    const detail = `Packet ${packetId} ended its read-only run without a complete Outcome, Evidence, Residual, and finding_ready receipt.`;
    const blockedLane = updateLane(lane.id, {
      status: 'awaiting_input',
      outcome: null,
      outcomeNote: detail,
      lastEventAt: completedAt,
      lastEventLabel: 'read_only_evidence_missing',
    }, 'system') ?? lane;

    const current = readOrchestratorControlPlaneState();
    if (current.packets.some((packet) => packet.id === packetId)) {
      await withLockedState((state) => {
        const packet = state.packets.find((candidate) => candidate.id === packetId);
        if (packet) markPacketEvidenceMissing(packet, completedAt, blockedLane);
      });
    }

    if (resolved.missionId) {
      try {
        await withMissionRegistryState(resolved.missionId, (state) => {
          const packet = state.packets.find((candidate) => candidate.id === packetId);
          if (packet) markPacketEvidenceMissing(packet, completedAt, blockedLane);
          return { state, result: null };
        });
      } catch (error) {
        console.warn(`[read-only-completion] Failed to block mission ${resolved.missionId}:`, error);
      }
    }

    return { completed: false, blocked: true, detail, lane: blockedLane };
  }

  const completedLane = updateLane(lane.id, {
    status: 'completed',
    outcome: 'no_changes',
    outcomeNote: context?.selfReview?.outcome?.trim()
      || 'Read-only inspection completed without repository changes.',
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
