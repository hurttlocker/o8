import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { normalizeOrchestratorMissionState, packetReleaseBlockedBy } from './store';
import type { OrchestratorLaneBinding, OrchestratorMissionState, OrchestratorPacket } from './types';

function buildPacketPrompt(packet: OrchestratorPacket) {
  return [
    `Packet: ${packet.title}`,
    packet.summary ? `Summary: ${packet.summary}` : null,
    packet.branchTarget ? `Branch target: ${packet.branchTarget}` : null,
    packet.dependencyLabels.length > 0 ? `Dependencies: ${packet.dependencyLabels.join(', ')}` : null,
    'Stay within this packet scope. Surface blockers, review handoffs, and required operator decisions explicitly.',
  ].filter((value): value is string => Boolean(value)).join('\n');
}

function createLaneBinding(packet: OrchestratorPacket, laneId: string, sessionKey?: string | null): OrchestratorLaneBinding {
  return {
    tileId: '',
    tabId: '',
    repoPath: packet.workspaceTargetPath,
    runtime: packet.runtime,
    laneId,
    sessionKey: sessionKey ?? null,
    lastHeartbeatAt: null,
    lastEventAt: new Date().toISOString(),
    lastEventLabel: 'dispatch_started',
  };
}

/**
 * Check if a packet can be dispatched.
 * Returns null if dispatchable, or a string reason if blocked.
 */
export function getDispatchBlocker(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
): string | null {
  if (packet.queueState !== 'queued') {
    return 'Not queued';
  }
  if (packet.status !== 'queued') {
    return `Status is ${packet.status}`;
  }
  const dependency = packetReleaseBlockedBy(packet, allPackets);
  if (dependency) {
    return `Blocked by ${dependency.id}`;
  }
  if (!packet.workspaceTargetPath) {
    return 'No workspace target';
  }
  if (packet.lane?.laneId || packet.lane?.sessionKey || (packet.lane?.tileId && packet.lane?.tabId)) {
    return 'Already dispatched';
  }
  return null;
}

/**
 * Run one dispatch tick. For each queued packet with no blockers and no lane binding,
 * dispatch via the lane command bus.
 * Returns the updated mission state.
 */
export async function runDispatchTick(
  state: OrchestratorMissionState,
): Promise<OrchestratorMissionState> {
  let nextState = normalizeOrchestratorMissionState(state);

  for (const packet of nextState.packets) {
    const blocker = getDispatchBlocker(packet, nextState.packets);
    if (blocker !== null) {
      continue;
    }

    try {
      console.log(`[dispatch] Dispatching packet ${packet.id}: ${packet.title}`);

      const laneResult = await dispatchLaneCommand({
        verb: 'open_lane',
        packetId: packet.id,
        repoPath: packet.workspaceTargetPath!,
        branch: packet.branchTarget,
        runtime: packet.runtime,
        label: packet.title,
        actor: 'orchestrator',
      });

      if (!laneResult.ok || !laneResult.laneId) {
        throw new Error(laneResult.note || 'Unable to open lane.');
      }

      const launchResult = await dispatchLaneCommand({
        verb: 'launch_session',
        laneId: laneResult.laneId,
        prompt: buildPacketPrompt(packet),
        actor: 'orchestrator',
      });

      if (!launchResult.ok) {
        throw new Error(launchResult.note || 'Unable to launch session.');
      }

      nextState = normalizeOrchestratorMissionState({
        ...nextState,
        packets: nextState.packets.map((candidate) => (
          candidate.id === packet.id
            ? {
                ...candidate,
                status: 'launching',
                blockedReason: null,
                lane: createLaneBinding(candidate, laneResult.laneId!, launchResult.lane?.sessionKey ?? null),
              }
            : candidate
        )),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Dispatch failed.';
      nextState = normalizeOrchestratorMissionState({
        ...nextState,
        packets: nextState.packets.map((candidate) => (
          candidate.id === packet.id
            ? {
                ...candidate,
                status: 'blocked',
                blockedReason: reason,
              }
            : candidate
        )),
      });
    }
  }

  return nextState;
}
