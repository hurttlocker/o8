import { aggregateMissionCost } from '@/lib/orchestrator/cost-aggregator';
import { resolveWorkerRouting } from '@/lib/agents/routing';
import { reconcileOrchestratorControlPlaneState, withLockedState, writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { buildDagMetadata, buildDependencyGraph } from '@/lib/orchestrator/dag';
import { buildRemainingLaunchBudget, runDispatchTick } from '@/lib/orchestrator/dispatch';
import { findLaneByPacket } from '@/lib/lane/registry';
import { resolveBranchPrefixSync } from '@/lib/operator/defaults';
import { currentLaneMergePolicy } from '@/lib/lane/dogfood-guard';
import { listArtifacts, toArtifactRef } from '@/lib/artifacts/store';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import { archiveMissionsExcept, getMissionRecord, recordMission } from '@/lib/db/missions-store';
import { readMissionRegistryEntry, withMissionRegistryState } from '@/lib/orchestrator/mission-registry';
import {
  latestTranscriptEventAt,
  readSessionTranscriptEvents,
} from '@/lib/orchestrator/packet-transcript';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { getTopRulesForPacket, readRepoScopedRules } from '@/lib/dispatch/rules-store';
import { recommendRuntime } from '@/lib/dispatch/routing';
import { prepareMissionBranches, type MissionBranchDecision } from './branch-cleanup';
import {
  buildMissionId,
  buildMissionPrompt,
  buildMissionSummary,
  buildPacketId,
  buildPacketSummary,
  currentMissionState,
  ensureRepoPath,
  extractIssueDependencies,
  isInlineIssue,
  log,
  missionAgentKeys,
  normalizeLoadedIssue,
  slugify,
} from './shared';
import type {
  CreateMissionInput,
  DispatchMissionInput,
  LoadedIssue,
  MissionStatusInput,
} from './types';

const INLINE_BRANCH_MAX_LENGTH = 60;

function branchTargetForIssue(issue: LoadedIssue) {
  if (!isInlineIssue(issue)) {
    return `${resolveBranchPrefixSync()}/${issue.number}-${slugify(issue.title)}`;
  }

  const prefix = `inline/${issue.number}-`;
  return `${prefix}${slugify(issue.title, Math.max(1, INLINE_BRANCH_MAX_LENGTH - prefix.length))}`;
}

export async function createMission(input: CreateMissionInput) {
  const repoPath = ensureRepoPath(input.repoPath);
  if (!Array.isArray(input.issues) || input.issues.length === 0) {
    throw new Error('At least one loaded issue is required.');
  }

  const loadedIssues = input.issues.map((issue, index) => normalizeLoadedIssue(issue, index));
  const duplicateIssueNumber = loadedIssues.find((issue, index) => (
    loadedIssues.findIndex((candidate) => candidate.number === issue.number) !== index
  ));
  if (duplicateIssueNumber) {
    throw new Error(`Duplicate issue number detected: #${duplicateIssueNumber.number}.`);
  }

  const availableIssueNumbers = new Set(loadedIssues.map((issue) => issue.number));
  const explicitDependencies = loadedIssues.map((issue) => (
    extractIssueDependencies(issue.body, availableIssueNumbers).filter((dependency) => dependency !== issue.number)
  ));
  const hasExplicitDependencies = explicitDependencies.some((dependencies) => dependencies.length > 0);

  const missionId = buildMissionId();
  const packetIds = loadedIssues.map(() => buildPacketId());
  // #453 — Use "inline-N" labels for ad-hoc tasks, "P{N}" for GitHub issues
  const hasInlineIssues = loadedIssues.some(isInlineIssue);
  const referenceLabels = loadedIssues.map((issue, index) =>
    isInlineIssue(issue) ? `inline-${index + 1}` : `P${index + 1}`,
  );
  const packetIdByIssueNumber = new Map(loadedIssues.map((issue, index) => [issue.number, packetIds[index] as string]));
  const referenceLabelByIssueNumber = new Map(loadedIssues.map((issue, index) => [issue.number, referenceLabels[index] as string]));
  const branchTargets = loadedIssues.map((issue) => branchTargetForIssue(issue));
  const priorState = currentMissionState();
  const workerRouting = resolveWorkerRouting({
    workerIntent: input.workerIntent,
    requestedProvider: input.requestedProvider,
    requestedRuntime: input.requestedRuntime ?? input.runtime,
    requestedModel: input.requestedModel,
    requestedEffort: input.requestedEffort,
    source: 'mission-create',
  });
  const branchPreparation = await prepareMissionBranches({
    repoPath,
    candidates: loadedIssues.map((issue, index) => ({
      issue,
      branchTarget: branchTargets[index]!,
    })),
    previousPackets: priorState.packets,
    existingBranchPolicy: input.existingBranchPolicy,
  });

  const packets = loadedIssues.map((issue, index) => {
    const dependencyNumbers = explicitDependencies[index].length > 0
      ? explicitDependencies[index]
      : !hasExplicitDependencies && input.sequential && index > 0
        ? [loadedIssues[index - 1]!.number]
        : [];

    // Per-issue runtime — a mission can mix Codex + Gemini packets (the swarm
    // "split coding/thinking" path). When the issue pins its own runtime, route
    // that packet through it; otherwise inherit the mission-level routing.
    const packetRouting = issue.runtime
      ? resolveWorkerRouting({
          workerIntent: input.workerIntent,
          requestedProvider: input.requestedProvider,
          requestedRuntime: issue.runtime,
          requestedModel: input.requestedModel,
          requestedEffort: input.requestedEffort,
          source: 'mission-create-packet',
        })
      : workerRouting;

    // #453/#inline-branch-hardening — Inline tasks carry their unique issue
    // number in the branch to avoid same-title mission collisions.
    const branchTarget = branchTargets[index]!;
    const inlineLabel = hasInlineIssues ? referenceLabels[index] : undefined;
    const packetSummary = buildPacketSummary(issue, input.constraints, repoPath, inlineLabel);

    // #615 — Snapshot learned-rules + issue body for the details popover.
    const packetType = issue.title.trim().split(/\s+/)[0]?.toLowerCase() || 'feat';
    let learnedRules: string[] = [];
    try {
      const seen = new Set<string>();
      learnedRules = [
        ...readRepoScopedRules(repoPath).map((ruleText) => ({ ruleText, source: 'file' as const })),
        ...getTopRulesForPacket({ repoPath, packetType, limit: 5 }),
      ].flatMap((rule) => {
        const text = rule.ruleText.trim();
        const normalized = text.toLowerCase();
        if (!text || seen.has(normalized)) return [];
        seen.add(normalized);
        return [text];
      });
    } catch {
      learnedRules = [];
    }

    const issueMeta = isInlineIssue(issue)
      ? (issue.body?.trim() ? { number: issue.number, body: issue.body } : undefined)
      : {
          number: issue.number,
          ...(issue.body?.trim() ? { body: issue.body } : {}),
          ...(issue.url?.trim() ? { url: issue.url } : {}),
        };

    return {
      id: packetIds[index]!,
      referenceLabel: referenceLabels[index]!,
      title: issue.title,
      summary: packetSummary,
      workspaceTargetPath: repoPath,
      branchTarget,
      runtime: packetRouting.selectedRuntime,
      dependencyLabels: dependencyNumbers.map((dependency) => referenceLabelByIssueNumber.get(dependency) ?? `#${dependency}`),
      dependencyPacketIds: dependencyNumbers.map((dependency) => packetIdByIssueNumber.get(dependency) ?? '').filter(Boolean),
      queueState: 'queued',
      releaseState: 'pending',
      status: 'queued',
      blockedReason: null,
      lastEventAt: null,
      lastEventLabel: null,
      archivedAt: null,
      review: null,
      lane: null,
      assignedModel: packetRouting.selectedModel,
      workerIntent: packetRouting.workerIntent,
      workerRouting: packetRouting,
      dispatchRuntimePin: packetRouting.requestedRuntime ?? packetRouting.selectedRuntime,
      prompt: [issue.title, packetSummary].map((part) => part.trim()).filter(Boolean).join('\n\n'),
      ...(learnedRules.length > 0 ? { learnedRules } : {}),
      ...(issueMeta ? { issue: issueMeta } : {}),
      ...(typeof input.useBrain === 'boolean' ? { useBrain: input.useBrain } : {}),
      ...(typeof input.huddle === 'boolean' ? { huddle: input.huddle } : {}),
      // #1329 — carry the dispatching orchestrator thread id so the worker
      // inherits that thread's session rules via `buildPacketPrompt`.
      ...(typeof input.orchestratorThreadId === 'string' && input.orchestratorThreadId.trim()
        ? { orchestratorThreadId: input.orchestratorThreadId.trim() }
        : {}),
      // Best-of-N: stamp the seed packet so fanOutComparisonPackets (scheduling.ts)
      // splits it into N sibling candidates, one per model, each its own worktree.
      ...(input.comparisonModels && input.comparisonModels.length > 0
        ? { comparisonModels: input.comparisonModels }
        : {}),
    } satisfies OrchestratorPacket;
  });

  const mission = normalizeOrchestratorMissionState({
    version: 2,
    missionId,
    prompt: buildMissionPrompt(loadedIssues, repoPath, input.constraints),
    summary: buildMissionSummary(loadedIssues, repoPath),
    repoPath,
    runtime: workerRouting.selectedRuntime,
    constraints: input.constraints,
    packets,
    updatedAt: new Date().toISOString(),
  });

  const { state: persisted } = await withLockedState((current) => {
    // Replace the mission under the control-plane lock so a concurrent
    // headless tick cannot restore a stale mission after createMission returns.
    Object.assign(current, mission);
  });
  const waves = new Map(buildDependencyGraph(persisted.packets).map((node) => [node.packetId, node.wave] as const));

  log(`Created mission ${missionId} with ${persisted.packets.length} packets.`);
  logBranchPreparation(branchPreparation, missionId);

  // Archive this mission in SQLite so get_mission_status can serve queries
  // for it later, even after a subsequent createMission overwrites the
  // file-based "current" mission. Lane/packet status is reconstructed live
  // via the lanes table. Non-fatal — file path still works on failure.
  try {
    const totalWaves = Math.max(1, ...Array.from(waves.values()));
    recordMission({
      id: missionId,
      repoPath,
      runtime: workerRouting.selectedRuntime,
      prompt: persisted.prompt,
      summary: persisted.summary,
      constraints: input.constraints,
      packetMeta: persisted.packets.map((packet) => ({
        id: packet.id,
        title: packet.title,
        referenceLabel: packet.referenceLabel,
      })),
      missionState: persisted,
      totalWaves,
    });
    archiveMissionsExcept(missionId);
  } catch (error) {
    log(`Failed to archive mission ${missionId} to SQLite (file path still works): ${error instanceof Error ? error.message : String(error)}`);
  }

  // #747 — Per-packet routing recommendation snapshot. Logs the runtime the
  // recommender would have picked next to the operator's actual choice. We
  // never override the user's selection — this is observability so we can see
  // whether the heuristic agrees with current operator behavior.
  void logDispatchRoutingRecommendations(persisted.packets, missionId).catch((error) => {
    console.warn(
      '[dispatch-routing] recommendation logging failed:',
      error instanceof Error ? error.message : error,
    );
  });

  return {
    missionId,
    packets: persisted.packets.map((packet) => ({
      id: packet.id,
      title: packet.title,
      wave: waves.get(packet.id) ?? 1,
    })),
    branchPreparation: branchPreparation.filter((decision) => decision.action !== 'none'),
  };
}

function logBranchPreparation(decisions: MissionBranchDecision[], missionId: string) {
  const prepared = decisions.filter((decision) => decision.action !== 'none');
  if (prepared.length === 0) return;
  log(`Prepared ${prepared.length} existing branch${prepared.length === 1 ? '' : 'es'} for mission ${missionId}.`, {
    branches: prepared.map((decision) => ({
      issue: decision.issueNumber,
      branch: decision.branchTarget,
      action: decision.action,
      reason: decision.reason,
      lanesArchived: decision.lanesArchived,
      worktreePruned: decision.worktreePruned,
      branchDeleted: decision.branchDeleted,
    })),
  });
}

async function logDispatchRoutingRecommendations(
  packets: OrchestratorPacket[],
  missionId: string,
): Promise<void> {
  // Group by repo so we only score each repo once per mission.
  const byRepo = new Map<string, OrchestratorPacket[]>();
  for (const packet of packets) {
    const repo = packet.workspaceTargetPath?.trim();
    if (!repo) continue;
    const prior = byRepo.get(repo) ?? [];
    prior.push(packet);
    byRepo.set(repo, prior);
  }

  for (const [repoPath, repoPackets] of byRepo) {
    const recommendation = await recommendRuntime(repoPath);
    for (const packet of repoPackets) {
      const matched = recommendation.runtime !== null && packet.runtime === recommendation.runtime;
      const evidenceSummary = Object.values(recommendation.evidence)
        .map((row) => `${row.runtime}=${row.mergedClean}/${row.total}`)
        .join(' ') || 'no-history';
      console.log(
        `[dispatch-routing] mission=${missionId} packet=${packet.referenceLabel} repo=${repoPath} chose=${packet.runtime} recommended=${recommendation.runtime ?? 'none'} score=${recommendation.score.toFixed(2)} matched=${matched} evidence=${evidenceSummary}`,
      );
    }
  }
}

export async function dispatchMission(input: DispatchMissionInput) {
  const before = currentMissionState();
  const requestedMissionId = input.missionId?.trim();
  const currentMissionId = before.missionId?.trim() ?? '';

  if (requestedMissionId && requestedMissionId !== currentMissionId) {
    const { result, state: finalState } = await withMissionRegistryState(requestedMissionId, async (stored) => {
      const registryBefore = reconcileOrchestratorControlPlaneState(stored);
      for (const packet of registryBefore.packets) {
        if (packet.queueState === 'held') packet.queueState = 'queued';
      }
      const afterDispatch = await runDispatchTick(registryBefore, { launchBudget: buildRemainingLaunchBudget() });
      const beforeByPacketId = new Map(registryBefore.packets.map((packet) => [packet.id, packet] as const));
      const dispatched = afterDispatch.packets.filter((packet) => {
        const previous = beforeByPacketId.get(packet.id);
        const hadLane = Boolean(previous?.lane?.laneId || previous?.lane?.sessionKey);
        const hasLane = Boolean(packet.lane?.laneId || packet.lane?.sessionKey);
        return !hadLane && hasLane;
      }).length;
      return { state: afterDispatch, result: dispatched };
    });

    const packetIds = new Set(finalState.packets.map((packet) => packet.id));
    const dag = buildDagMetadata(finalState.packets);
    log(`Dispatched mission ${finalState.missionId || requestedMissionId} with ${result} packet launches.`);

    return {
      dispatched: result,
      waves: dag.totalWaves,
      activeAgents: missionAgentKeys(packetIds),
    };
  }

  // Use locked state to prevent race with headless loop tick
  const { result, state: finalState } = await withLockedState(async (current) => {
    // #23 — an EXPLICIT dispatch re-arms any packet a prior reset_packet left in
    // 'held'. Held packets are skipped by the supervisor's automatic dispatch tick
    // (so reset doesn't boomerang); an explicit dispatch_mission is the operator
    // opting back in, so promote held -> queued here before dispatching.
    for (const packet of current.packets) {
      if (packet.queueState === 'held') packet.queueState = 'queued';
    }
    const afterDispatch = await runDispatchTick(current, { launchBudget: buildRemainingLaunchBudget() });
    // #1293 — make withLockedState's end-of-lock reconcile+write use the
    // post-dispatch state, not the unmutated pre-callback `current`. Without this
    // a best-of-N seed survives the dispatch (its candidate lanes don't map back
    // to the seed id under reconcile) and re-fans on the next headless tick.
    Object.assign(current, afterDispatch);
    writeOrchestratorControlPlaneState(afterDispatch);

    const beforeByPacketId = new Map(before.packets.map((packet) => [packet.id, packet] as const));
    const dispatched = afterDispatch.packets.filter((packet) => {
      const previous = beforeByPacketId.get(packet.id);
      const hadLane = Boolean(previous?.lane?.laneId || previous?.lane?.sessionKey);
      const hasLane = Boolean(packet.lane?.laneId || packet.lane?.sessionKey);
      return !hadLane && hasLane;
    }).length;

    return dispatched;
  });

  const packetIds = new Set(finalState.packets.map((packet) => packet.id));
  const dag = buildDagMetadata(finalState.packets);

  log(`Dispatched mission ${finalState.missionId || 'current'} with ${result} packet launches.`);

  return {
    dispatched: result,
    waves: dag.totalWaves,
    activeAgents: missionAgentKeys(packetIds),
  };
}

interface MissionTranscriptActivity {
  lastTranscriptAt: string | null;
  transcriptUnsupportedReason: string | null;
}

function latestIsoTimestamp(...timestamps: Array<string | null | undefined>): string | null {
  let latestMs = 0;
  let latestIso: string | null = null;

  for (const timestamp of timestamps) {
    if (!timestamp) continue;
    const parsed = new Date(timestamp).getTime();
    if (!Number.isFinite(parsed) || parsed <= latestMs) continue;
    latestMs = parsed;
    latestIso = new Date(parsed).toISOString();
  }

  return latestIso;
}

function activityLabel(
  lastActivityAt: string | null,
  lastTranscriptAt: string | null,
  lastEventLabel: string | null | undefined,
) {
  return lastActivityAt && lastTranscriptAt && lastActivityAt === lastTranscriptAt
    ? 'transcript_activity'
    : lastEventLabel ?? null;
}

async function readTranscriptActivityBySession(
  sessionKeys: string[],
): Promise<Map<string, MissionTranscriptActivity>> {
  const uniqueKeys = [...new Set(sessionKeys.map((key) => key.trim()).filter(Boolean))];
  const pairs = await Promise.all(uniqueKeys.map(async (sessionKey) => {
    try {
      const readback = await readSessionTranscriptEvents(sessionKey);
      return [sessionKey, {
        lastTranscriptAt: latestTranscriptEventAt(readback.events),
        transcriptUnsupportedReason: readback.unsupportedReason ?? null,
      }] as const;
    } catch {
      return [sessionKey, {
        lastTranscriptAt: null,
        transcriptUnsupportedReason: null,
      }] as const;
    }
  }));

  return new Map(pairs);
}

/**
 * Build a lite mission status snapshot from the SQLite archive + live lanes.
 *
 * Used by `getMissionStatus` when the requested mission isn't the current
 * file-based active mission. Packet wave grouping, queue/release states, and
 * review results aren't reconstructed (we don't archive that depth) — just
 * the lane lifecycle (status, branch, last event), which is the answer to
 * "is my parallel mission done yet?"
 */
function buildHistoricalMissionStatus(record: import('@/lib/db/missions-store').MissionRecord) {
  const lanesByPacket = new Map<string, ReturnType<typeof findLaneByPacket>>();
  const mergePolicy = currentLaneMergePolicy();
  for (const meta of record.packetMeta) {
    lanesByPacket.set(meta.id, findLaneByPacket(meta.id));
  }

  const inferPacketStatus = (lane: ReturnType<typeof findLaneByPacket>): string => {
    if (!lane) return 'unknown';
    switch (lane.status) {
      case 'completed':
      case 'archived':
        return 'completed';
      case 'reviewing':
        return 'awaiting_review';
      case 'merging':
        return 'merging';
      case 'failed':
      case 'recovering':
        return 'failed';
      case 'launching':
      case 'running':
        return 'running';
      case 'awaiting_input':
      case 'awaiting_orchestrator':
        return 'blocked';
      case 'idle':
      case 'paused':
        return lane.status;
      default:
        return 'unknown';
    }
  };

  const inferReleaseState = (lane: ReturnType<typeof findLaneByPacket>) => (
    lane?.status === 'completed' ? 'released' : 'pending'
  );

  const packets = record.packetMeta.map((meta) => {
    const lane = lanesByPacket.get(meta.id) ?? null;
    return {
      id: meta.id,
      referenceLabel: meta.referenceLabel,
      title: meta.title,
      wave: 1,
      status: inferPacketStatus(lane),
      queueState: lane ? 'released' : 'unknown',
      releaseState: inferReleaseState(lane),
      blockedBy: [] as string[],
      blockedReason: null,
      lane: lane ? {
        laneId: lane.id,
        sessionKey: lane.sessionKey,
        runtime: lane.runtime,
        status: lane.status,
        branch: lane.branch,
        repoPath: lane.worktreePath ?? lane.repoPath,
        lastEventAt: lane.lastEventAt,
        lastLifecycleEventAt: lane.lastEventAt,
        lastTranscriptAt: null,
        lastActivityAt: lane.lastEventAt,
        lastActivityLabel: lane.lastEventLabel,
        transcriptUnsupportedReason: null,
        lastEventLabel: lane.lastEventLabel,
        mergeMode: mergePolicy.mode,
        mergeModeNote: mergePolicy.note,
      } : null,
      review: null,
    };
  });

  const agents = record.packetMeta
    .map((meta) => {
      const lane = lanesByPacket.get(meta.id) ?? null;
      if (!lane) return null;
      return {
        packetId: meta.id,
        laneId: lane.id,
        sessionKey: lane.sessionKey,
        label: lane.label,
        runtime: lane.runtime,
        status: lane.status,
        branch: lane.branch,
        repoPath: lane.worktreePath ?? lane.repoPath,
        lastEventAt: lane.lastEventAt,
        lastLifecycleEventAt: lane.lastEventAt,
        lastTranscriptAt: null,
        lastActivityAt: lane.lastEventAt,
        lastActivityLabel: lane.lastEventLabel,
        transcriptUnsupportedReason: null,
        lastEventLabel: lane.lastEventLabel,
      };
    })
    .filter((agent): agent is NonNullable<typeof agent> => agent !== null);

  return {
    missionId: record.id,
    prompt: record.prompt,
    summary: record.summary,
    repoPath: record.repoPath,
    runtime: record.runtime,
    constraints: record.constraints,
    currentWave: 1,
    totalWaves: record.totalWaves,
    packets,
    agents,
    blockers: [] as Array<{ packetId: string; blockedBy: string[]; reason: string | null }>,
    historical: true,
  };
}

export async function getMissionStatus(input: MissionStatusInput) {
  const currentState = currentMissionState();
  const requestedMissionId = input.missionId?.trim();
  const currentMissionId = (currentState.missionId ?? '').trim();
  const isCurrent = !requestedMissionId || requestedMissionId === currentMissionId;
  let state = currentState;

  if (!isCurrent) {
    const registryEntry = readMissionRegistryEntry(requestedMissionId, { includeArchived: true });
    if (registryEntry) {
      state = reconcileOrchestratorControlPlaneState(registryEntry.mission);
    } else {
      const record = getMissionRecord(requestedMissionId);
      if (!record) {
        throw new Error(`Mission ${requestedMissionId} not found.`);
      }
      return buildHistoricalMissionStatus(record);
    }
  }

  const graph = buildDependencyGraph(state.packets);
  const dag = buildDagMetadata(state.packets);
  const packetById = new Map(state.packets.map((packet) => [packet.id, packet] as const));
  const laneByPacketId = new Map(state.packets.map((packet) => [packet.id, findLaneByPacket(packet.id)] as const));
  const sessionKeys = state.packets.flatMap((packet) => {
    const lane = laneByPacketId.get(packet.id);
    const sessionKey = lane?.sessionKey ?? packet.lane?.sessionKey ?? null;
    return sessionKey ? [sessionKey] : [];
  });
  const transcriptActivityBySession = await readTranscriptActivityBySession(sessionKeys);
  const mergePolicy = currentLaneMergePolicy();

  const agents = state.packets
    .map((packet) => {
      const lane = laneByPacketId.get(packet.id);
      if (!lane) {
        return null;
      }
      const activity = lane.sessionKey ? transcriptActivityBySession.get(lane.sessionKey) : undefined;
      const lastTranscriptAt = activity?.lastTranscriptAt ?? null;
      const lastLifecycleEventAt = lane.lastEventAt;
      const lastActivityAt = latestIsoTimestamp(lastLifecycleEventAt, lastTranscriptAt);

      return {
        packetId: packet.id,
        laneId: lane.id,
        sessionKey: lane.sessionKey,
        label: lane.label,
        runtime: lane.runtime,
        status: lane.status,
        branch: lane.branch,
        repoPath: lane.worktreePath ?? lane.repoPath,
        lastEventAt: lastActivityAt ?? lastLifecycleEventAt,
        lastLifecycleEventAt,
        lastTranscriptAt,
        lastActivityAt,
        lastActivityLabel: activityLabel(lastActivityAt, lastTranscriptAt, lane.lastEventLabel),
        transcriptUnsupportedReason: activity?.transcriptUnsupportedReason ?? null,
        lastEventLabel: lane.lastEventLabel,
        mergeMode: mergePolicy.mode,
        mergeModeNote: mergePolicy.note,
      };
    })
    .filter((agent): agent is NonNullable<typeof agent> => agent !== null);

  const blockers = graph
    .map((node) => {
      const packet = packetById.get(node.packetId);
      return {
        packetId: node.packetId,
        blockedBy: node.blockedBy,
        reason: packet?.blockedReason ?? null,
      };
    })
    .filter((blocker) => blocker.blockedBy.length > 0 || blocker.reason);

  const cost = input.includeCost ? await aggregateMissionCost(state) : undefined;

  return {
    missionId: state.missionId || '',
    prompt: state.prompt,
    summary: state.summary,
    repoPath: state.repoPath ?? null,
    runtime: state.runtime ?? 'codex',
    constraints: state.constraints ?? '',
    currentWave: dag.currentWave,
    totalWaves: dag.totalWaves,
    packets: graph.map((node) => {
      const packet = packetById.get(node.packetId)!;
      const lane = laneByPacketId.get(node.packetId);
      const laneSessionKey = lane?.sessionKey ?? packet.lane?.sessionKey ?? null;
      const activity = laneSessionKey ? transcriptActivityBySession.get(laneSessionKey) : undefined;
      const lastTranscriptAt = activity?.lastTranscriptAt ?? null;
      const laneLastEventAt = lane?.lastEventAt ?? packet.lane?.lastEventAt ?? null;
      const lastActivityAt = latestIsoTimestamp(laneLastEventAt, lastTranscriptAt);
      return {
        id: packet.id,
        referenceLabel: packet.referenceLabel,
        title: packet.title,
        wave: node.wave,
        status: packet.status,
        queueState: packet.queueState,
        releaseState: packet.releaseState,
        blockedBy: node.blockedBy,
        blockedReason: packet.blockedReason ?? null,
        lane: lane ? {
          laneId: lane.id,
          sessionKey: lane.sessionKey,
          runtime: lane.runtime,
          status: lane.status,
          branch: lane.branch,
          repoPath: lane.worktreePath ?? lane.repoPath,
          lastEventAt: lastActivityAt ?? lane.lastEventAt,
          lastLifecycleEventAt: lane.lastEventAt,
          lastTranscriptAt,
          lastActivityAt,
          lastActivityLabel: activityLabel(lastActivityAt, lastTranscriptAt, lane.lastEventLabel),
          transcriptUnsupportedReason: activity?.transcriptUnsupportedReason ?? null,
          lastEventLabel: lane.lastEventLabel,
          mergeMode: mergePolicy.mode,
          mergeModeNote: mergePolicy.note,
        } : packet.lane ? {
          ...packet.lane,
          lastEventAt: lastActivityAt ?? packet.lane.lastEventAt ?? null,
          lastLifecycleEventAt: packet.lane.lastEventAt ?? null,
          lastTranscriptAt,
          lastActivityAt,
          lastActivityLabel: activityLabel(lastActivityAt, lastTranscriptAt, packet.lane.lastEventLabel),
          transcriptUnsupportedReason: activity?.transcriptUnsupportedReason ?? null,
          mergeMode: mergePolicy.mode,
          mergeModeNote: mergePolicy.note,
        } : null,
        review: packet.review ? {
          approved: packet.review.approved,
          findingsCount: packet.review.findings.length,
          summary: packet.review.summary,
          recordedAt: packet.review.recordedAt,
          reviewedHeadSha: packet.review.reviewedHeadSha ?? null,
          auditApprovalId: packet.review.auditApprovalId ?? null,
        } : null,
        // Visual verification proof (#1147) — slim refs (url + phase/pair/label),
        // never raw disk paths. Rides back to the orchestrator so a "done/merged"
        // packet surfaces its before/after screenshots alongside the verdict.
        artifacts: listArtifacts({ packetId: packet.id }).map(toArtifactRef),
      };
    }),
    agents,
    blockers,
    ...(cost ? { cost } : {}),
  };
}
