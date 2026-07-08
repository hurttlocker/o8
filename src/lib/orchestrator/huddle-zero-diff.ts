import { getLaneEvents, setLaneStatus } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { resolvePacketAdvisorEnabled } from '@/lib/orchestrator/advisor-access';
import { readOrchestratorControlPlaneState, withLockedState } from '@/lib/orchestrator/control-plane';
import { resolvePacketHuddleEnabled } from '@/lib/orchestrator/huddle-access';

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
  if (!packet) return { parked: false };

  // An explicit huddle packet is DESIGNED to produce a zero-diff alignment turn.
  // So is a single-sub cheap-tier worker: it's auto-armed with the SAME
  // plan-then-stop alignment turn via the advisor prompt (resolvePacketAdvisorEnabled),
  // so its zero-diff exit is equally EXPECTED. Park either for the orchestrator
  // rather than classifying it `zero_diff_failed` (which structurally kills the
  // steer path, #1496). Reuse the advisor predicate — never re-derive the tier
  // logic here.
  //
  // We previously ALSO required a persisted `huddle` report or a plan-like
  // transcript, but that gate false-failed real alignment exits: the headless
  // transcript drops (#1502) and workers sometimes report via
  // `needs_clarification` instead of `huddle`. So the readiness probe is now
  // only an observability annotation — never a reason to withhold parking.
  const alignmentArmed = resolvePacketHuddleEnabled(packet) || resolvePacketAdvisorEnabled(packet);
  if (!alignmentArmed) return { parked: false };

  const huddleReady = hasPersistedHuddleReport(lane.id) || await transcriptEndsWithPlan(lane);
  if (!huddleReady) {
    console.log(`[lane-lifecycle] Alignment-armed packet ${packetId} exited zero-diff without an explicit plan signal; parking for orchestrator anyway (#1496).`);
  }

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
