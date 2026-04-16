import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { clearStaleLaneBinding, getDispatchableWave } from '@/lib/orchestrator/dag';
import { normalizeOrchestratorMissionState, packetReleaseBlockedBy } from '@/lib/orchestrator/store';
import type {
  OrchestratorLaneBinding,
  OrchestratorMissionState,
  OrchestratorPacket,
} from '@/lib/orchestrator/types';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';

import { buildPacketPrompt } from './packet-prompt';
import { computePredictedFiles, filterOverlappingPackets } from './preservation-envelope';

export const MAX_PARALLEL_DISPATCHES = 4;
export const MAX_RECOVERY_DISPATCHES = 2;

const RECOVERY_COOLDOWN_MS = 60_000;
const SESSION_RECOVERY_COMMIT_MESSAGE = 'auto-commit: session recovery';
const execFileAsync = promisify(execFile);

function buildComparisonGroupId() {
  return `cmp-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function fanOutComparisonPackets(state: OrchestratorMissionState): OrchestratorMissionState {
  const activeComparisonGroups = new Set(state.activeComparisonGroups ?? []);
  const nextPackets: OrchestratorPacket[] = [];
  let changed = false;

  for (const packet of state.packets) {
    const comparisonModels = (packet.comparisonModels ?? [])
      .map((model) => model.trim())
      .filter(Boolean);
    const shouldFanOut = comparisonModels.length > 0 && !packet.comparisonGroupId;

    if (!shouldFanOut) {
      nextPackets.push(packet);
      continue;
    }

    changed = true;
    const comparisonGroupId = buildComparisonGroupId();
    activeComparisonGroups.add(comparisonGroupId);
    console.log(
      `[best-of-n] Fanning out ${packet.id} into ${comparisonModels.length} comparison lane${comparisonModels.length === 1 ? '' : 's'} (${comparisonModels.join(', ')})`,
    );

    comparisonModels.forEach((model, index) => {
      nextPackets.push({
        ...packet,
        id: `${packet.id}-cmp-${index}`,
        title: `${packet.title} (${model})`,
        branchTarget: `${packet.branchTarget}-cmp-${index}`,
        queueState: 'queued',
        releaseState: 'pending',
        status: 'queued',
        blockedReason: null,
        lastEventAt: null,
        lastEventLabel: null,
        archivedAt: null,
        review: null,
        lane: null,
        comparisonModels: undefined,
        comparisonGroupId,
        comparisonIndex: index,
        assignedModel: model,
      });
    });
  }

  if (!changed) {
    return state;
  }

  return normalizeOrchestratorMissionState({
    ...state,
    packets: nextPackets,
    activeComparisonGroups: [...activeComparisonGroups],
    updatedAt: new Date().toISOString(),
  });
}

function createLaneBinding(packet: OrchestratorPacket, laneId: string, sessionKey?: string | null): OrchestratorLaneBinding {
  return {
    tileId: '',
    tabId: '',
    repoPath: packet.workspaceTargetPath,
    worktreePath: null,
    runtime: packet.runtime,
    laneId,
    sessionKey: sessionKey ?? null,
    lastHeartbeatAt: null,
    lastEventAt: new Date().toISOString(),
    lastEventLabel: 'dispatch_started',
  };
}

interface DispatchResult {
  kind: 'launched' | 'awaiting_review';
  laneId: string | null;
  sessionKey: string | null;
  lane?: OrchestratorLaneBinding | null;
}

interface LaunchDispatchResult {
  laneId: string;
  sessionKey: string | null;
}

interface RecoveryDispatchContext {
  lane: OrchestratorLaneBinding | null;
  worktreePath: string | null;
}

function isDispatchReadyStatus(packet: OrchestratorPacket) {
  return packet.status === 'queued' || packet.status === 'recovering';
}

async function hasUncommittedWorktreeChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
    cwd: worktreePath,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim().length > 0;
}

async function autoCommitRecoveryWorktree(worktreePath: string): Promise<void> {
  await execFileAsync('git', ['add', '-A'], {
    cwd: worktreePath,
    maxBuffer: 10 * 1024 * 1024,
  });
  await execFileAsync('git', ['commit', '-m', SESSION_RECOVERY_COMMIT_MESSAGE], {
    cwd: worktreePath,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function dispatchOrRecoverPacket(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
  recoveryContext?: RecoveryDispatchContext | null,
): Promise<DispatchResult> {
  if (packet.status === 'recovering' && recoveryContext?.worktreePath) {
    const hasUncommittedChanges = await hasUncommittedWorktreeChanges(recoveryContext.worktreePath);
    if (hasUncommittedChanges) {
      await autoCommitRecoveryWorktree(recoveryContext.worktreePath);

      if (recoveryContext.lane?.laneId) {
        const reviewResult = await dispatchLaneCommand({
          verb: 'request_review',
          laneId: recoveryContext.lane.laneId,
          actor: 'orchestrator',
        });
        if (!reviewResult.ok) {
          throw new Error(reviewResult.note || 'Unable to request review after session recovery.');
        }
      }

      return {
        kind: 'awaiting_review',
        laneId: recoveryContext.lane?.laneId ?? null,
        sessionKey: null,
        lane: recoveryContext.lane
          ? {
              ...recoveryContext.lane,
              sessionKey: null,
            }
          : null,
      };
    }
  }

  const launchResult = await dispatchPacket(packet, allPackets);
  return {
    kind: 'launched',
    laneId: launchResult.laneId,
    sessionKey: launchResult.sessionKey,
  };
}

async function dispatchPacket(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
): Promise<LaunchDispatchResult> {
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
    prompt: await buildPacketPrompt(
      packet,
      allPackets,
      laneResult.lane?.baseBranch ?? 'main',
      laneResult.lane?.worktreePath ?? null,
    ),
    model: packet.assignedModel ?? undefined,
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
  const candidate = packet.status === 'recovering' ? clearStaleLaneBinding(packet) : packet;

  if (candidate.queueState !== 'queued') {
    return 'Not queued';
  }
  if (candidate.status === 'failed') {
    return 'Failed — max recovery attempts exceeded';
  }
  if (!isDispatchReadyStatus(candidate)) {
    return `Status is ${candidate.status}`;
  }
  // #455 — Block dispatch if recovery limit exceeded
  if (candidate.status === 'recovering' && (candidate.recoveryCount ?? 0) >= MAX_RECOVERY_DISPATCHES) {
    return `Recovery limit exceeded (${candidate.recoveryCount}/${MAX_RECOVERY_DISPATCHES})`;
  }
  const dependency = packetReleaseBlockedBy(candidate, allPackets);
  if (dependency) {
    return `Blocked by ${dependency.id}`;
  }
  if (!candidate.workspaceTargetPath) {
    return 'No workspace target';
  }
  if (candidate.lane?.laneId || candidate.lane?.sessionKey || (candidate.lane?.tileId && candidate.lane?.tabId)) {
    // Allow retry if the lane's last event was a launch failure
    const lastEvent = candidate.lane?.lastEventLabel ?? '';
    if (lastEvent === 'launch_error' || lastEvent === 'launch_failed') {
      // Clear the stale binding so dispatchPacket can re-open/re-launch
    } else {
      return 'Already dispatched';
    }
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
  nextState = fanOutComparisonPackets(nextState);
  const recoveryContextByPacketId = new Map(
    nextState.packets.flatMap((packet) => (
      packet.status === 'recovering'
        ? [[packet.id, {
            lane: packet.lane ?? null,
            worktreePath: packet.lane?.repoPath ?? null,
          }] as const]
        : []
    )),
  );

  // Compute predicted files for all packets (used by overlap gate + dashboard)
  nextState = {
    ...nextState,
    packets: nextState.packets.map((packet) => {
      if (packet.predictedFiles) return packet;
      const files = computePredictedFiles(packet);
      return files.length > 0 ? { ...packet, predictedFiles: files } : packet;
    }),
  };

  // #380 — Filter out packets that overlap with active work on the same files
  const activePackets = nextState.packets.filter((p) => p.status === 'running' || p.status === 'launching');
  const wavePackets = getDispatchableWave(nextState.packets);
  const overlapFiltered = filterOverlappingPackets(wavePackets, activePackets);

  const dispatchablePackets = overlapFiltered
    .map((packet) => ({
      packet,
      recoveryContext: recoveryContextByPacketId.get(packet.id) ?? null,
    }))
    .filter(({ packet }) => {
      if (getDispatchBlocker(packet, nextState.packets) !== null) {
        return false;
      }
      // #455 — Recovery cooldown: skip packets that were recovered too recently
      if (packet.status === 'recovering' || recoveryContextByPacketId.has(packet.id)) {
        const lastRecovery = packet.lastRecoveryAt ? Date.now() - new Date(packet.lastRecoveryAt).getTime() : Infinity;
        if (lastRecovery < RECOVERY_COOLDOWN_MS) {
          console.log(`[recovery] Packet ${packet.id} skipped — recovery cooldown (${Math.round(lastRecovery / 1000)}s < ${RECOVERY_COOLDOWN_MS / 1000}s)`);
          return false;
        }
      }
      return true;
    });

  if (dispatchablePackets.length === 0) {
    return nextState;
  }

  for (let index = 0; index < dispatchablePackets.length; index += MAX_PARALLEL_DISPATCHES) {
    const batch = dispatchablePackets.slice(index, index + MAX_PARALLEL_DISPATCHES);
    console.log(`[dag-scheduler] Dispatching ${batch.length} packets in parallel: ${batch.map(({ packet }) => packet.id).join(', ')}`);

    const results = await Promise.allSettled(
      batch.map(({ packet, recoveryContext }) => dispatchOrRecoverPacket(packet, nextState.packets, recoveryContext)),
    );
    nextState = normalizeOrchestratorMissionState({
      ...nextState,
      packets: nextState.packets.map((candidate) => {
        const batchIndex = batch.findIndex(({ packet }) => packet.id === candidate.id);
        if (batchIndex === -1) {
          return candidate;
        }

        const wasRecovering = recoveryContextByPacketId.has(candidate.id);
        const recoveryCount = (candidate.recoveryCount ?? 0) + (wasRecovering ? 1 : 0);
        const recoveryFields = wasRecovering
          ? { recoveryCount, lastRecoveryAt: new Date().toISOString() }
          : {};

        if (wasRecovering) {
          console.log(`[recovery] Packet ${candidate.id} recovery attempt ${recoveryCount}/${MAX_RECOVERY_DISPATCHES}`);
        }

        const result = results[batchIndex];
        if (result.status === 'fulfilled') {
          if (result.value.kind === 'awaiting_review') {
            return {
              ...candidate,
              ...recoveryFields,
              status: 'awaiting_review',
              blockedReason: null,
              lastEventAt: new Date().toISOString(),
              lastEventLabel: 'session_recovery_autocommit',
              lane: result.value.lane ?? candidate.lane ?? null,
            };
          }

          void publishRealtimeMutation({
            mutation: {
              mutationId: `packet-dispatch-${candidate.id}-${Date.now()}`,
              source: 'server',
              action: 'packet-dispatch',
              status: 'completed',
              runtime: candidate.runtime,
              surfaceId: result.value.sessionKey ?? undefined,
              sessionKey: result.value.sessionKey ?? undefined,
              laneId: result.value.laneId ?? undefined,
              packetId: candidate.id,
              packetTitle: candidate.title,
              packetReferenceLabel: candidate.referenceLabel,
              repoPath: candidate.workspaceTargetPath ?? undefined,
              branch: candidate.branchTarget,
              note: `Dispatched ${candidate.referenceLabel} to ${candidate.runtime}`,
              createdAt: new Date().toISOString(),
              settledAt: new Date().toISOString(),
            },
            refreshTargets: ['global', 'mobileInbox', 'sessionHistory'],
            sessionKeys: result.value.sessionKey ? [result.value.sessionKey] : [],
            fresh: true,
          });
          return {
            ...candidate,
            ...recoveryFields,
            status: 'launching',
            blockedReason: null,
            lane: createLaneBinding(candidate, result.value.laneId!, result.value.sessionKey),
          };
        }

        const reason = result.reason instanceof Error ? result.reason.message : 'Dispatch failed.';
        console.error(`[dag-scheduler] Failed to dispatch packet ${candidate.id}: ${reason}`);
        return {
          ...candidate,
          ...recoveryFields,
          status: 'blocked',
          blockedReason: reason,
        };
      }),
    });
  }

  return nextState;
}
