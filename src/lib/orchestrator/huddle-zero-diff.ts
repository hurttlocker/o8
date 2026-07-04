import { getLaneEvents, setLaneStatus } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { readOrchestratorControlPlaneState, withLockedState } from '@/lib/orchestrator/control-plane';

export const HUDDLE_READY_EVENT_LABEL = 'huddle_ready';

function hasPersistedHuddleReport(laneId: string): boolean {
  return getLaneEvents(laneId, 500).some((event) =>
    event.verb === 'agent_report' && event.payload.event === 'huddle'
  );
}

function looksLikeFinalPlan(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return /\b(implementation plan|plan:|here'?s (my )?plan|i'?ll|i will)\b/.test(normalized);
}

async function transcriptEndsWithPlan(lane: Lane): Promise<boolean> {
  const sessionKey = lane.sessionKey?.trim();
  if (!sessionKey) return false;

  try {
    const { readRuntimeTranscript } = await import('@/lib/runtime/transcript');
    const transcript = await readRuntimeTranscript(sessionKey, { limit: 12 });
    const finalAssistant = [...transcript].reverse().find((entry) =>
      entry.role === 'assistant' && entry.text.trim().length > 0
    );
    return finalAssistant ? looksLikeFinalPlan(finalAssistant.text) : false;
  } catch {
    return false;
  }
}

export async function parkHuddleReadyZeroDiffLane(lane: Lane): Promise<{ parked: boolean; lane?: Lane }> {
  const packetId = lane.packetId?.trim();
  if (!packetId) return { parked: false };

  const state = readOrchestratorControlPlaneState();
  const packet = state.packets.find((candidate) => candidate.id === packetId);
  if (packet?.huddle !== true) return { parked: false };

  const huddleReady = hasPersistedHuddleReport(lane.id) || await transcriptEndsWithPlan(lane);
  if (!huddleReady) return { parked: false };

  const now = new Date().toISOString();
  const parkedLane = setLaneStatus(lane.id, 'awaiting_orchestrator', 'system', HUDDLE_READY_EVENT_LABEL) ?? lane;

  await withLockedState((current) => {
    const currentPacket = current.packets.find((candidate) => candidate.id === packetId);
    if (!currentPacket) return;
    currentPacket.status = 'blocked';
    currentPacket.blockedReason = HUDDLE_READY_EVENT_LABEL;
    currentPacket.lastEventAt = now;
    currentPacket.lastEventLabel = HUDDLE_READY_EVENT_LABEL;
    if (currentPacket.lane) {
      currentPacket.lane = {
        ...currentPacket.lane,
        laneId: parkedLane.id,
        sessionKey: parkedLane.sessionKey ?? lane.sessionKey ?? null,
        lastEventAt: now,
        lastEventLabel: HUDDLE_READY_EVENT_LABEL,
      };
    }
  });

  return { parked: true, lane: parkedLane };
}
