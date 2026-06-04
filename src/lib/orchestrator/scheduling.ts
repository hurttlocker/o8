import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { surfaceEdgeCases } from '@/lib/dispatch/edge-case-surfacer';
import { computeReadBudget, resolveModelTier } from '@/lib/dispatch/read-budget';
import { getRuntimeCapability } from '@/lib/orchestrator/runtime-capabilities';
import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { getLane } from '@/lib/lane/registry';
import { resolveOverlapGateSync, resolveParallelCapSync } from '@/lib/operator/defaults';
import { clearStaleLaneBinding, getDispatchableWave } from '@/lib/orchestrator/dag';
import { normalizeOrchestratorMissionState, packetReleaseBlockedBy } from '@/lib/orchestrator/store';
import { getProjectContext } from '@/lib/projects/context';
import { resolveWorkerRouting } from '@/lib/agents/routing';
import {
  MCP_DISPATCH_TILE_SENTINEL,
  type OrchestratorLaneBinding,
  type OrchestratorMissionState,
  type OrchestratorPacket,
  type WorkerRouting,
} from '@/lib/orchestrator/types';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';

import { buildPacketPrompt } from './packet-prompt';
import { computePredictedFiles, filterOverlappingPackets } from './preservation-envelope';

// Back-compat export — resolves env var, then the persisted operator default,
// then the locked fallback (5). Existing imports keep working.
export const MAX_PARALLEL_DISPATCHES = resolveParallelCapSync();
export const MAX_RECOVERY_DISPATCHES = 2;

const RECOVERY_COOLDOWN_MS = 60_000;
const SESSION_RECOVERY_COMMIT_MESSAGE = 'auto-commit: session recovery';
const execFileAsync = promisify(execFile);

function isGitRepoSync(repoPath: string) {
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf-8',
      timeout: 5_000,
      maxBuffer: 128 * 1024,
    }).trim() === 'true';
  } catch {
    return false;
  }
}

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

function createLaneBinding(
  packet: OrchestratorPacket,
  laneId: string,
  sessionKey?: string | null,
  workerRouting?: WorkerRouting,
): OrchestratorLaneBinding {
  // Read the SQLite lane row so the binding reflects what `updateLane` already
  // persisted (most importantly `worktreePath`, written in commands.ts during
  // `bind_worktree` / `launch_session`). Without this, MCP-dispatched packets
  // saw `worktreePath: null` on the binding even though a real worktree
  // existed, and the no_changes_produced check inspected the wrong tree.
  // tileId/tabId do not live on the lane row, but writing empty strings here
  // made every downstream truthy check (`hasInteractiveLane`, `hasLaneBinding`)
  // hide the Focus button for MCP-dispatched packets (#1113). The sentinel
  // keeps those checks truthy and is filtered out by the workspace tile-handle
  // lookup, so this never collides with a real workspace binding.
  const laneRow = getLane(laneId);
  return {
    tileId: MCP_DISPATCH_TILE_SENTINEL,
    tabId: MCP_DISPATCH_TILE_SENTINEL,
    repoPath: packet.workspaceTargetPath,
    worktreePath: laneRow?.worktreePath ?? null,
    runtime: workerRouting?.selectedRuntime ?? packet.runtime,
    laneId,
    sessionKey: sessionKey ?? null,
    lastHeartbeatAt: null,
    lastEventAt: new Date().toISOString(),
    lastEventLabel: 'dispatch_started',
  };
}

interface AwaitingReviewDispatchResult {
  kind: 'awaiting_review';
  laneId: string | null;
  sessionKey: string | null;
  lane?: OrchestratorLaneBinding | null;
}

interface LaunchedDispatchResult {
  kind: 'launched';
  laneId: string;
  sessionKey: string | null;
  workerRouting: WorkerRouting;
}

type DispatchResult = AwaitingReviewDispatchResult | LaunchedDispatchResult;

interface LaunchDispatchResult {
  laneId: string;
  sessionKey: string | null;
  workerRouting: WorkerRouting;
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
    workerRouting: launchResult.workerRouting,
  };
}

async function dispatchPacket(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
): Promise<LaunchDispatchResult> {
  const workerRouting = resolveWorkerRouting({
    workerIntent: packet.workerIntent,
    requestedProvider: packet.workerRouting?.requestedProvider,
    requestedRuntime: packet.workerRouting?.requestedRuntime ?? packet.runtime,
    requestedModel: packet.workerRouting?.requestedModel ?? packet.assignedModel,
    source: 'scheduler-dispatch',
  });
  const projectContext = await getProjectContext({ repoPath: packet.workspaceTargetPath });
  const laneResult = await dispatchLaneCommand({
    verb: 'open_lane',
    packetId: packet.id,
    repoPath: packet.workspaceTargetPath!,
    projectId: projectContext.runtimeProjectId,
    branch: packet.branchTarget,
    runtime: workerRouting.selectedRuntime,
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
    // Fallback ladder: explicit packet model → capability-map default → undefined.
    // This ensures Gemini/opencode dispatches actually pin the flagship model
    // from the capability map instead of letting the CLI pick a cheaper default.
    model: (workerRouting.selectedModel ?? getRuntimeCapability(workerRouting.selectedRuntime).defaultModel) ?? undefined,
    actor: 'orchestrator',
  });

  if (!launchResult.ok) {
    throw new Error(launchResult.note || 'Unable to launch session.');
  }

  return {
    laneId: laneResult.laneId,
    sessionKey: launchResult.lane?.sessionKey ?? null,
    workerRouting,
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
  if (!isGitRepoSync(candidate.workspaceTargetPath)) {
    return 'This folder isn\'t a Git repository — initialize Git to dispatch agents into it.';
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

  // #535 — Populate `readBudget` for any queued packet that doesn't already
  // have one set. Dispatch-site injection only — in-flight packets (running,
  // launching, awaiting_review, etc.) are left untouched so we never mutate
  // a prompt under an agent's feet. The computed budget is opt-out: when
  // `computeReadBudget` returns null (no targets, strong tier w/ no graph),
  // the packet field stays undefined and legacy behaviour is preserved.
  nextState = {
    ...nextState,
    packets: nextState.packets.map((packet) => {
      if (packet.readBudget) return packet;
      if (packet.status !== 'queued' && packet.status !== 'recovering' && packet.status !== 'draft') {
        return packet;
      }
      const repoPath = packet.workspaceTargetPath;
      const targetFiles = packet.predictedFiles ?? [];
      if (!repoPath || targetFiles.length === 0) return packet;
      const routing = resolveWorkerRouting({
        workerIntent: packet.workerIntent,
        requestedProvider: packet.workerRouting?.requestedProvider,
        requestedRuntime: packet.workerRouting?.requestedRuntime ?? packet.runtime,
        requestedModel: packet.workerRouting?.requestedModel ?? packet.assignedModel,
        source: 'scheduler-enrichment',
      });
      const tier = resolveModelTier({ runtime: routing.selectedRuntime, assignedModel: routing.selectedModel });
      const budget = computeReadBudget({ repoPath, targetFiles, tier });
      return budget ? { ...packet, runtime: routing.selectedRuntime, workerIntent: routing.workerIntent, workerRouting: routing, readBudget: budget } : { ...packet, runtime: routing.selectedRuntime, workerIntent: routing.workerIntent, workerRouting: routing };
    }),
  };

  // #536 — Populate `edgeCaseSites` on the same enrichment gate so any
  // packet queued without a surfacer pass picks one up at dispatch time.
  // `surfaceEdgeCases` never throws; on garbage input it returns empty,
  // which collapses to an undefined field (legacy-identical).
  nextState = {
    ...nextState,
    packets: nextState.packets.map((packet) => {
      if (packet.edgeCaseSites && packet.edgeCaseSites.length > 0) return packet;
      if (packet.status !== 'queued' && packet.status !== 'recovering' && packet.status !== 'draft') {
        return packet;
      }
      const repoPath = packet.workspaceTargetPath;
      const targetFiles = packet.predictedFiles ?? [];
      if (!repoPath || targetFiles.length === 0) return packet;
      const { sites } = surfaceEdgeCases({ repoPath, targetFiles, depth: 1 });
      return sites.length > 0 ? { ...packet, edgeCaseSites: sites } : packet;
    }),
  };

  // #380 — Predicted-file overlap is now ADVISORY ONLY by default. The dispatch
  // loop fans every wave packet out in parallel; conflicts get resolved at
  // rebase time (the merge gate already enforces clean rebases). This keeps
  // parallelism a root behavior so the orchestrator can still merge while
  // codex packets work in their isolated worktrees.
  // Set O8_STRICT_OVERLAP_GATE=1 (or flip Settings → Dispatch & Supervision →
  // Overlap gate to "strict") to restore the old serializing behavior.
  const overlapGate = resolveOverlapGateSync();
  const activePackets = nextState.packets.filter((p) => p.status === 'running' || p.status === 'launching');
  const wavePackets = getDispatchableWave(nextState.packets);
  const overlapFiltered = overlapGate === 'strict'
    ? filterOverlappingPackets(wavePackets, activePackets)
    : wavePackets;
  if (overlapGate !== 'strict' && wavePackets.length > 1) {
    const wouldFilter = filterOverlappingPackets(wavePackets, activePackets);
    if (wouldFilter.length < wavePackets.length) {
      const held = wavePackets.filter((p) => !wouldFilter.find((kept) => kept.id === p.id));
      console.log(`[overlap-gate] Advisory only — would have held ${held.length} packets: ${held.map((p) => p.id).join(', ')}`);
    }
  }

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

  const parallelCap = resolveParallelCapSync();
  // Per-runtime parallel cap — Gemini 3.1 Pro drops concurrent calls past ~3
  // (observed: 4-packet parallel burst lost 1 silently with no stderr). Other
  // runtimes have no additional cap beyond the global.
  const RUNTIME_PARALLEL_CAP: Partial<Record<typeof dispatchablePackets[number]['packet']['runtime'], number>> = {
    gemini: 3,
  };
  const queue = [...dispatchablePackets];
  while (queue.length > 0) {
    const batch: typeof dispatchablePackets = [];
    const deferred: typeof dispatchablePackets = [];
    const runtimeCountsInBatch: Record<string, number> = {};
    for (const candidate of queue) {
      const runtime = candidate.packet.runtime;
      const perRuntimeCap = RUNTIME_PARALLEL_CAP[runtime];
      const hitRuntimeCap =
        perRuntimeCap !== undefined && (runtimeCountsInBatch[runtime] ?? 0) >= perRuntimeCap;
      if (batch.length < parallelCap && !hitRuntimeCap) {
        batch.push(candidate);
        runtimeCountsInBatch[runtime] = (runtimeCountsInBatch[runtime] ?? 0) + 1;
      } else {
        deferred.push(candidate);
      }
    }
    if (batch.length === 0) break;
    queue.length = 0;
    queue.push(...deferred);
    console.log(`[dag-scheduler] Dispatching ${batch.length} packets in parallel (cap ${parallelCap}): ${batch.map(({ packet }) => packet.id).join(', ')}`);

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
          const workerRouting = result.value.workerRouting;

          void publishRealtimeMutation({
            mutation: {
              mutationId: `packet-dispatch-${candidate.id}-${Date.now()}`,
              source: 'server',
              action: 'packet-dispatch',
              status: 'completed',
              runtime: workerRouting.selectedRuntime,
              surfaceId: result.value.sessionKey ?? undefined,
              sessionKey: result.value.sessionKey ?? undefined,
              laneId: result.value.laneId ?? undefined,
              packetId: candidate.id,
              packetTitle: candidate.title,
              packetReferenceLabel: candidate.referenceLabel,
              repoPath: candidate.workspaceTargetPath ?? undefined,
              branch: candidate.branchTarget,
              note: `Dispatched ${candidate.referenceLabel} to ${workerRouting.selectedRuntime}`,
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
            runtime: workerRouting.selectedRuntime,
            workerIntent: workerRouting.workerIntent,
            workerRouting,
            status: 'launching',
            blockedReason: null,
            lane: createLaneBinding(candidate, result.value.laneId!, result.value.sessionKey, workerRouting),
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
