import { getLane, updateLane } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { readOrchestratorControlPlaneState, withLockedState } from '@/lib/orchestrator/control-plane';
import { findMissionRegistryEntryByPacketId, withMissionRegistryState } from '@/lib/orchestrator/mission-registry';
import { resolvePacketLaunchContext } from '@/lib/orchestrator/packet-launch-context';
import { markPacketReleased } from '@/lib/orchestrator/packet-release-truth';
import type { OrchestratorPacket, PacketContext } from '@/lib/orchestrator/types';
import { packetReleaseGeneration, packetReleaseIdentityIsCurrent } from './release-ownership';
import { persistCapturedCompletionHandoff } from '@/lib/orchestrator/completion-handoff';

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
  const currentPacket = readOrchestratorControlPlaneState().packets.find((packet) => packet.id === packetId);
  const entry = !currentPacket ? findMissionRegistryEntryByPacketId(packetId, { includeArchived: true }) : null;
  const snapshot = currentPacket ?? entry?.mission.packets.find((packet) => packet.id === packetId);
  if (!snapshot || snapshot.launchContext?.workMode !== 'read-only') return { completed: false };
  const generation = packetReleaseGeneration(snapshot, lane.id);
  const completedAt = new Date().toISOString();
  const hasReceipt = hasCompleteReadOnlyReceipt(context) && context?.packetId === packetId
    && (!lane.sessionKey || context?.sessionKey === lane.sessionKey);
  const detail = `Packet ${packetId} ended its read-only run without a complete Outcome, Evidence, Residual, and finding_ready receipt.`;
  const apply = async (packet: OrchestratorPacket | undefined): Promise<ReadOnlyCompletionResult> => {
    const checkAccepted = () => {
      const fresh = getLane(lane.id);
      const durable = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId)
        ?? findMissionRegistryEntryByPacketId(packetId)?.mission.packets.find((candidate) => candidate.id === packetId);
      if (!packet || !fresh || packet.launchContext?.workMode !== 'read-only'
        || fresh.sessionKey !== lane.sessionKey || ['paused', 'archived'].includes(fresh.status)
        || !durable || !packetReleaseIdentityIsCurrent(durable, lane.id, generation)
        || !packetReleaseIdentityIsCurrent(packet, lane.id, generation)) throw new Error('Read-only completion owner changed.');
    };
    const freshLane = getLane(lane.id);
    try { checkAccepted(); } catch { return { completed: false }; }
    if (hasReceipt) {
      try {
        await persistCapturedCompletionHandoff(context!, 'no_changes', checkAccepted);
        checkAccepted();
      } catch (error) {
        console.warn(`[completion-handoff] Read-only completion retained without publication: ${error instanceof Error ? error.message : String(error)}`);
        return { completed: false, blocked: true, detail: 'Private completion handoff could not verify the current owner and source. Retain the workspace and provider archive.' };
      }
    }
    const settledLane = updateLane(lane.id, {
      status: hasReceipt ? 'completed' : 'awaiting_input',
      outcome: hasReceipt ? 'no_changes' : null,
      outcomeNote: hasReceipt ? context!.selfReview!.outcome!.trim() : detail,
      lastEventAt: completedAt,
      lastEventLabel: hasReceipt ? READ_ONLY_COMPLETED_EVENT_LABEL : 'read_only_evidence_missing',
    }, 'system') ?? freshLane!;
    if (hasReceipt) markPacketCompleted(packet!, completedAt, settledLane);
    else markPacketEvidenceMissing(packet!, completedAt, settledLane);
    return hasReceipt ? { completed: true, lane: settledLane }
      : { completed: false, blocked: true, detail, lane: settledLane };
  };
  // Mutate the durable owner only. The headless tick mirrors current missions;
  // a second unlocked lookup here could apply this old result to a new owner.
  if (currentPacket) {
    return (await withLockedState((state) => apply(state.packets.find((packet) => packet.id === packetId)))).result;
  }
  return (await withMissionRegistryState(entry!.id, async (state) => ({
    state, result: await apply(state.packets.find((packet) => packet.id === packetId)),
  }))).result;
}
