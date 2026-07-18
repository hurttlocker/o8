import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

import { surfaceEdgeCases } from '@/lib/dispatch/edge-case-surfacer';
import { computeReadBudget, resolveModelTier } from '@/lib/dispatch/read-budget';
import { getRuntimeCapability } from '@/lib/orchestrator/runtime-capabilities';
import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { getLane, findLaneByPacket, listLanes } from '@/lib/lane/registry';
import { salvagedWorkBlockReason } from '@/lib/supervisor/heal-guard';
import { recordLaneEvent } from '@/lib/lane/events';
import { listSessionRuleTexts } from '@/lib/db/session-rules-store';
import { resolveOverlapGateSync, resolveParallelCapSync } from '@/lib/operator/defaults';
import { clearStaleLaneBinding, getDispatchableWave } from '@/lib/orchestrator/dag';
import { normalizeOrchestratorMissionState, packetReleaseBlockedBy } from '@/lib/orchestrator/store';
import { fanOutComparisonPackets } from '@/lib/orchestrator/comparison-fanout';
import { getProjectContext } from '@/lib/projects/context';
import { resolveWorkerRouting } from '@/lib/agents/routing';
import {
  MCP_DISPATCH_TILE_SENTINEL,
  type OrchestratorLaneBinding,
  type OrchestratorMissionState,
  type OrchestratorPacket,
  type OrchestratorRuntime,
  type WorkerRouting,
} from '@/lib/orchestrator/types';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { assertRuntimeDispatchable } from '@/lib/runtimes/shared/auth-detect';
import { isDispatchHalted } from './dispatch-halt';

import { buildPacketPrompt } from './packet-prompt';
import { computePredictedFiles, filterOverlappingPackets } from './preservation-envelope';

// Back-compat export — resolves env var, then the persisted operator default,
// then the locked fallback (5). Existing imports keep working.
export const MAX_PARALLEL_DISPATCHES = resolveParallelCapSync();
export const MAX_RECOVERY_DISPATCHES = 2;
// Packet-scoped launch/attach cap. The per-lane LAUNCH_ATTEMPT_CAP (lane/commands.ts)
// resets when a fresh lane is minted on redispatch, so it never accumulated — the
// launching<->idle thrash. This counter lives on the packet so it survives.
export const MAX_LAUNCH_ATTEMPTS = 5;
export const RUNTIME_PARALLEL_CAP: Partial<Record<OrchestratorRuntime, number>> = {
  gemini: 3,
};

export interface DispatchLaunchBudget {
  maxLaunches: number;
  perRuntime?: Partial<Record<OrchestratorRuntime, number>>;
}

export function buildRemainingLaunchBudget(): DispatchLaunchBudget {
  const parallelCap = resolveParallelCapSync();
  const activeLanes = listLanes().filter((lane) => lane.status === 'launching' || lane.status === 'running');
  const perRuntime: Partial<Record<OrchestratorRuntime, number>> = {};
  for (const runtime of Object.keys(RUNTIME_PARALLEL_CAP) as OrchestratorRuntime[]) {
    const cap = RUNTIME_PARALLEL_CAP[runtime];
    if (cap === undefined) continue;
    const active = activeLanes.filter((lane) => lane.runtime === runtime).length;
    perRuntime[runtime] = Math.max(0, cap - active);
  }
  return {
    maxLaunches: Math.max(0, parallelCap - activeLanes.length),
    perRuntime,
  };
}

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
  laneId: string | null;
  baseBranch: string;
  runtime: OrchestratorRuntime | null;
}

function isDispatchReadyStatus(packet: OrchestratorPacket) {
  return packet.status === 'queued' || packet.status === 'recovering';
}

export function getBootRecoveryLaunchBlocker(input: {
  missionArchived?: boolean;
  missionLive?: boolean;
  packet: Pick<OrchestratorPacket, 'id' | 'status' | 'queueState' | 'archivedAt' | 'releaseState' | 'dispatchRuntimePin'>;
  pinnedRuntime?: OrchestratorRuntime | null;
}): string | null {
  const packet = input.packet;
  if (input.missionArchived || input.missionLive === false || packet.archivedAt || packet.releaseState === 'released') {
    return 'mission is not live';
  }
  if (packet.status !== 'queued' && packet.status !== 'recovering') {
    return `lane state does not expect a worker (${packet.status})`;
  }
  if (packet.queueState !== 'queued') {
    return `queue state is ${packet.queueState}`;
  }
  if (!input.pinnedRuntime) {
    return 'runtime is not pinned';
  }
  return null;
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
    const worktreePath = recoveryContext.worktreePath;
    const hasUncommittedChanges = await hasUncommittedWorktreeChanges(worktreePath);
    // #1293 — a silent-exited worker often ALREADY COMMITTED its diff (it does the
    // work, commits, passes checks, then exits without `turn.completed`). Salvage
    // committed work too — not just uncommitted — so the lane finalizes to review
    // FROM ITS OWN WORKTREE instead of falling through to dispatchPacket, which
    // opens a fresh, disconnected `isolate` worktree and orphans the real work
    // (the silent_exit_but_work_present loop). Only a genuinely empty worktree
    // (silent_exit_no_work) redispatches.
    let reviewable = hasUncommittedChanges;
    if (!reviewable) {
      try {
        const { hasReviewableCompletionDiff } = await import('@/lib/supervisor/completion-verification');
        reviewable = await hasReviewableCompletionDiff(worktreePath, recoveryContext.baseBranch);
      } catch { /* probe failed — fall through to redispatch */ }
    }
    if (reviewable) {
      if (hasUncommittedChanges) {
        await autoCommitRecoveryWorktree(worktreePath);
      }

      const laneId = recoveryContext.laneId ?? recoveryContext.lane?.laneId ?? null;
      if (laneId) {
        const reviewResult = await dispatchLaneCommand({
          verb: 'request_review',
          laneId,
          actor: 'orchestrator',
        });
        if (!reviewResult.ok) {
          throw new Error(reviewResult.note || 'Unable to request review after session recovery.');
        }
      }

      return {
        kind: 'awaiting_review',
        laneId: recoveryContext.laneId ?? recoveryContext.lane?.laneId ?? null,
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

  const launchPacket: OrchestratorPacket = recoveryContext?.runtime
    ? {
        ...packet,
        runtime: recoveryContext.runtime,
        workerRouting: packet.workerRouting
          ? {
              ...packet.workerRouting,
              requestedRuntime: recoveryContext.runtime,
              selectedRuntime: recoveryContext.runtime,
            }
          : packet.workerRouting,
      }
    : packet;
  const launchResult = await dispatchPacket(launchPacket, allPackets);
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
  await assertRuntimeDispatchable(workerRouting.selectedRuntime);
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
    effort: workerRouting.selectedEffort ?? undefined,
    actor: 'orchestrator',
  });

  if (!launchResult.ok) {
    throw new Error(launchResult.note || 'Unable to launch session.');
  }

  // #1329 — audit trail. Snapshot the exact session rules that governed this
  // packet at dispatch, so review reads as "what changed, under which
  // constraints." Best-effort — a bad read never blocks the launch.
  if (packet.orchestratorThreadId) {
    try {
      const rules = listSessionRuleTexts(packet.orchestratorThreadId);
      if (rules.length > 0) {
        recordLaneEvent(laneResult.laneId, 'rules_applied', 'orchestrator', {
          threadId: packet.orchestratorThreadId,
          ruleCount: rules.length,
          rules,
        });
      }
    } catch (error) {
      console.warn('[session-rules] failed to record rules_applied event', error);
    }
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

  // #1391 — salvaged work is not a fault to heal. A packet whose latest lane
  // sits in reviewing/merging (silent-exit salvage, open PR, approved review)
  // must never auto-redispatch, whatever churn its status/queueState went
  // through. Legit relaunch paths archive lanes first, so they pass.
  const salvageBlock = salvagedWorkBlockReason(candidate);
  if (salvageBlock) {
    return salvageBlock;
  }

  // Operator Stop is terminal — this is THE line that makes a Stop the loop
  // can't ignore. Every dispatch path funnels through here, so a stopped packet
  // can never be relaunched by the headless loop, a stall escalation, or a ralph
  // requeue. Cleared by reset_packet / explicit relaunch. (2026-06-22)
  if (candidate.operatorStopped) {
    return 'Operator stopped';
  }
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
  // Packet-scoped launch cap — stop the launching<->idle relaunch thrash. The
  // per-lane cap resets when a fresh lane is minted on redispatch (proven
  // lane-scoped-counter runaway); this one lives on the packet.
  if ((candidate.launchAttempts ?? 0) >= MAX_LAUNCH_ATTEMPTS) {
    return `Launch attempts exceeded (${candidate.launchAttempts}/${MAX_LAUNCH_ATTEMPTS})`;
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
/**
 * Merge a dispatch tick's outcome onto FRESH locked state, per packet —
 * never a whole-state overwrite. The tick runs outside the control-plane
 * lock (it clones worktrees and spawns sessions, seconds of work), so by the
 * time its result exists, concurrent locked writes (reviews, task creates,
 * resets) may have landed. Only packets the tick actually changed (or added)
 * are copied over; everything else keeps the fresh state. Adversarial F3 —
 * the old `writeOrchestratorControlPlaneState(afterDispatch)` from the
 * pre-tick snapshot clobbered every concurrent write on the merge path.
 */
export function mergeDispatchTickOutcome(
  fresh: OrchestratorMissionState,
  tickBase: OrchestratorMissionState,
  afterDispatch: OrchestratorMissionState,
): void {
  const baseById = new Map(tickBase.packets.map((packet) => [packet.id, JSON.stringify(packet)] as const));
  const freshIndexById = new Map(fresh.packets.map((packet, index) => [packet.id, index] as const));
  for (const packet of afterDispatch.packets) {
    const before = baseById.get(packet.id);
    if (before !== undefined && before === JSON.stringify(packet)) continue;
    const index = freshIndexById.get(packet.id);
    if (index === undefined) {
      fresh.packets.push(packet);
    } else {
      fresh.packets[index] = packet;
    }
  }
  fresh.updatedAt = afterDispatch.updatedAt ?? fresh.updatedAt;
}

export async function runDispatchTick(
  state: OrchestratorMissionState,
  options: { launchBudget?: DispatchLaunchBudget; enforceBootRecoveryGuard?: boolean; missionArchived?: boolean } = {},
): Promise<OrchestratorMissionState> {
  let nextState = normalizeOrchestratorMissionState(state);
  if (isDispatchHalted()) {
    return nextState;
  }
  nextState = fanOutComparisonPackets(nextState);
  const recoveryContextByPacketId = new Map(
    nextState.packets.flatMap((packet) => {
      if (packet.status !== 'recovering') return [];
      // #1293 — recover into the LANE's OWN worktree (where a silent-exited
      // worker's committed work lives), NOT the main repo. The old code read
      // `packet.lane?.repoPath` (the main checkout, always clean), so recovery
      // never found the work and always redispatched a fresh, disconnected
      // worktree. The reconciler also nulls `packet.lane` on the recovering
      // transition, so resolve the lane row by packetId for the authoritative
      // worktreePath + baseBranch + laneId.
      const row = findLaneByPacket(packet.id);
      const worktreePath = packet.lane?.worktreePath ?? row?.worktreePath ?? null;
      return [[packet.id, {
        lane: packet.lane ?? null,
        worktreePath,
        laneId: packet.lane?.laneId ?? row?.id ?? null,
        baseBranch: row?.baseBranch ?? 'main',
        runtime: row?.runtime ?? packet.lane?.runtime ?? null,
      } satisfies RecoveryDispatchContext] as const];
    }),
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
    .filter(({ packet, recoveryContext }) => {
      const recoveryBlocker = options.enforceBootRecoveryGuard
        ? getBootRecoveryLaunchBlocker({
            missionArchived: options.missionArchived,
            missionLive: !nextState.packets.every((candidate) => candidate.archivedAt || candidate.releaseState === 'released'),
            packet,
            pinnedRuntime: recoveryContext?.runtime ?? packet.dispatchRuntimePin ?? null,
          })
        : null;
      if (recoveryBlocker) {
        console.log(`[recovery] Packet ${packet.id} skipped — ${recoveryBlocker}`);
        return false;
      }
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
  const maxLaunches = options.launchBudget
    ? Math.max(0, Math.floor(options.launchBudget.maxLaunches))
    : Number.POSITIVE_INFINITY;
  if (maxLaunches <= 0) {
    return nextState;
  }
  const queue = [...dispatchablePackets];
  let launchedThisTick = 0;
  const runtimeCountsInTick: Partial<Record<OrchestratorRuntime, number>> = {};
  const effectiveRuntimeByPacket = new Map<string, OrchestratorRuntime>();
  while (queue.length > 0 && launchedThisTick < maxLaunches) {
    const batch: typeof dispatchablePackets = [];
    const deferred: typeof dispatchablePackets = [];
    const runtimeCountsInBatch: Partial<Record<OrchestratorRuntime, number>> = {};
    const batchLimit = Math.min(parallelCap, maxLaunches - launchedThisTick);
    for (const candidate of queue) {
      // Budget against the EFFECTIVE runtime, not the persisted one: a packet
      // stamped with a retired runtime (gemini) reroutes at dispatch (see
      // dispatchPacket's resolveWorkerRouting), and its launch must count
      // against the runtime it will actually run on — otherwise legacy packets
      // bypass the workhorse's parallel budget.
      const runtime = resolveWorkerRouting({
        workerIntent: candidate.packet.workerIntent,
        requestedProvider: candidate.packet.workerRouting?.requestedProvider,
        requestedRuntime: candidate.packet.workerRouting?.requestedRuntime ?? candidate.packet.runtime,
        requestedModel: candidate.packet.workerRouting?.requestedModel ?? candidate.packet.assignedModel,
        source: 'scheduler-budget',
      }).selectedRuntime;
      effectiveRuntimeByPacket.set(candidate.packet.id, runtime);
      const perRuntimeCap = RUNTIME_PARALLEL_CAP[runtime];
      const perRuntimeBudget = options.launchBudget?.perRuntime?.[runtime];
      const hitRuntimeCap =
        perRuntimeCap !== undefined && (runtimeCountsInBatch[runtime] ?? 0) >= perRuntimeCap;
      const hitRuntimeBudget =
        perRuntimeBudget !== undefined
        && (runtimeCountsInTick[runtime] ?? 0) + (runtimeCountsInBatch[runtime] ?? 0) >= perRuntimeBudget;
      if (batch.length < batchLimit && !hitRuntimeCap && !hitRuntimeBudget) {
        batch.push(candidate);
        runtimeCountsInBatch[runtime] = (runtimeCountsInBatch[runtime] ?? 0) + 1;
      } else {
        deferred.push(candidate);
      }
    }
    if (batch.length === 0) break;
    queue.length = 0;
    queue.push(...deferred);
    launchedThisTick += batch.length;
    for (const { packet } of batch) {
      const effective = effectiveRuntimeByPacket.get(packet.id) ?? packet.runtime;
      runtimeCountsInTick[effective] = (runtimeCountsInTick[effective] ?? 0) + 1;
    }
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

        // #1293 — a per-packet fold error (e.g. createLaneBinding → getLane, or a
        // malformed dispatch result) must NEVER throw out of this .map. If it did,
        // runDispatchTick would abort before the caller persists the dispatched
        // state, leaving an already-dispatched packet stuck 'queued' — so the next
        // tick re-dispatches it, opening a fresh lane + owned session every tick
        // (the second runaway path, distinct from the seed re-fan). Catch
        // per-packet so the tick always completes and persists; a fold failure
        // degrades that single packet to 'blocked' (terminal for getDispatchBlocker).
        try {
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
            if (!result.value.laneId) {
              throw new Error('Dispatch returned no lane id.');
            }

            void publishRealtimeMutation({
              mutation: {
                mutationId: `packet-dispatch-${candidate.id}-${Date.now()}`,
                source: 'server',
                action: 'packet-dispatch',
                status: 'completed',
                runtime: workerRouting.selectedRuntime,
                sessionKey: result.value.sessionKey ?? undefined,
                laneId: result.value.laneId ?? undefined,
                laneLabel: candidate.title,
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
              // Packet-scoped launch counter (survives the fresh lane minted on
              // each redispatch, unlike the per-lane cap). getDispatchBlocker
              // stops re-admitting this packet once it hits MAX_LAUNCH_ATTEMPTS.
              launchAttempts: (candidate.launchAttempts ?? 0) + 1,
              runtime: workerRouting.selectedRuntime,
              workerIntent: workerRouting.workerIntent,
              workerRouting,
              status: 'launching',
              blockedReason: null,
              lane: createLaneBinding(candidate, result.value.laneId, result.value.sessionKey, workerRouting),
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
        } catch (foldErr) {
          const msg = foldErr instanceof Error ? foldErr.message : 'Dispatch post-processing failed.';
          console.error(`[dag-scheduler] Fold-back error for ${candidate.id} — marking blocked so the tick can't loop:`, msg);
          return {
            ...candidate,
            ...recoveryFields,
            status: 'blocked',
            blockedReason: msg,
          };
        }
      }),
    });
  }

  return nextState;
}
