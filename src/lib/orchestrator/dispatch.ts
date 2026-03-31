import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { getDispatchableWave } from '@/lib/orchestrator/dag';
import { readPacketCompletionContext } from '@/lib/orchestrator/context-relay';
import { normalizeOrchestratorMissionState, packetReleaseBlockedBy } from '@/lib/orchestrator/store';
import type { OrchestratorLaneBinding, OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

export const MAX_PARALLEL_DISPATCHES = 4;

function formatChangedFiles(changedFiles: string[]) {
  if (changedFiles.length === 0) {
    return 'none recorded';
  }
  if (changedFiles.length <= 6) {
    return changedFiles.join(', ');
  }
  return `${changedFiles.slice(0, 6).join(', ')} (+${changedFiles.length - 6} more)`;
}

function truncatePromptText(text: string, max: number) {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

async function buildDependencyContextSections(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
): Promise<string[]> {
  if (packet.dependencyPacketIds.length === 0) {
    return [];
  }

  const packetById = new Map(allPackets.map((candidate) => [candidate.id, candidate]));
  const results = await Promise.allSettled(
    packet.dependencyPacketIds.map(async (dependencyPacketId) => {
      const dependencyPacket = packetById.get(dependencyPacketId);
      const context = await readPacketCompletionContext(dependencyPacketId);
      return { context, dependencyPacket, dependencyPacketId };
    }),
  );

  return results
    .filter((result): result is PromiseFulfilledResult<{
      context: Awaited<ReturnType<typeof readPacketCompletionContext>>;
      dependencyPacket: OrchestratorPacket | undefined;
      dependencyPacketId: string;
    }> => result.status === 'fulfilled')
    .flatMap(({ value }) => {
      if (!value.context) {
        return [];
      }

      const dependencyTitle = value.dependencyPacket?.title
        ?? value.dependencyPacket?.referenceLabel
        ?? value.dependencyPacketId;

      return [
        `Previous work from dependency '${dependencyTitle}': ${truncatePromptText(value.context.summary, 1_000)}`,
        `Files changed: ${formatChangedFiles(value.context.changedFiles)}`,
      ];
    });
}

async function buildPacketPrompt(packet: OrchestratorPacket, allPackets: OrchestratorPacket[]) {
  const dependencySections = await buildDependencyContextSections(packet, allPackets);
  if (dependencySections.length > 0) {
    console.log(`[context-pass] Injected dependency context for packet ${packet.id}`);
  }

  return [
    `Packet: ${packet.title}`,
    packet.summary ? `Summary: ${packet.summary}` : null,
    packet.branchTarget ? `Branch target: ${packet.branchTarget}` : null,
    packet.dependencyLabels.length > 0 ? `Dependencies: ${packet.dependencyLabels.join(', ')}` : null,
    dependencySections.length > 0 ? 'Dependency handoff context:' : null,
    ...dependencySections,
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

interface DispatchResult {
  laneId: string;
  sessionKey: string | null;
}

async function dispatchPacket(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
): Promise<DispatchResult> {
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
    prompt: await buildPacketPrompt(packet, allPackets),
    actor: 'orchestrator',
  });

  if (!launchResult.ok) {
    throw new Error(launchResult.note || 'Unable to launch session.');
  }

  return {
    laneId: laneResult.laneId,
    sessionKey: launchResult.lane?.sessionKey ?? null,
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

  const dispatchablePackets = getDispatchableWave(nextState.packets)
    .filter((packet) => getDispatchBlocker(packet, nextState.packets) === null);

  if (dispatchablePackets.length === 0) {
    return nextState;
  }

  for (let index = 0; index < dispatchablePackets.length; index += MAX_PARALLEL_DISPATCHES) {
    const batch = dispatchablePackets.slice(index, index + MAX_PARALLEL_DISPATCHES);
    console.log(`[dag-scheduler] Dispatching ${batch.length} packets in parallel: ${batch.map((packet) => packet.id).join(', ')}`);

    const results = await Promise.allSettled(batch.map((packet) => dispatchPacket(packet, nextState.packets)));
    nextState = normalizeOrchestratorMissionState({
      ...nextState,
      packets: nextState.packets.map((candidate) => {
        const batchIndex = batch.findIndex((packet) => packet.id === candidate.id);
        if (batchIndex === -1) {
          return candidate;
        }

        const result = results[batchIndex];
        if (result.status === 'fulfilled') {
          return {
            ...candidate,
            status: 'launching',
            blockedReason: null,
            lane: createLaneBinding(candidate, result.value.laneId, result.value.sessionKey),
          };
        }

        const reason = result.reason instanceof Error ? result.reason.message : 'Dispatch failed.';
        console.error(`[dag-scheduler] Failed to dispatch packet ${candidate.id}: ${reason}`);
        return {
          ...candidate,
          status: 'blocked',
          blockedReason: reason,
        };
      }),
    });
  }

  return nextState;
}
