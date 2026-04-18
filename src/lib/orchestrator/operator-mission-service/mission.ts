import { aggregateMissionCost } from '@/lib/orchestrator/cost-aggregator';
import { withLockedState, writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { buildDagMetadata, buildDependencyGraph } from '@/lib/orchestrator/dag';
import { runDispatchTick } from '@/lib/orchestrator/dispatch';
import { findLaneByPacket } from '@/lib/lane/registry';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
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
  normalizeMissionSelection,
  slugify,
} from './shared';
import type {
  CreateMissionInput,
  DispatchMissionInput,
  MissionStatusInput,
} from './types';

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

  const packets = loadedIssues.map((issue, index) => {
    const dependencyNumbers = explicitDependencies[index].length > 0
      ? explicitDependencies[index]
      : !hasExplicitDependencies && input.sequential && index > 0
        ? [loadedIssues[index - 1]!.number]
        : [];

    // #453 — Inline tasks get "inline/{slug}" branches, not "issue/{number}-{slug}"
    const branchTarget = isInlineIssue(issue)
      ? `inline/${slugify(issue.title)}`
      : `issue/${issue.number}-${slugify(issue.title)}`;
    const inlineLabel = hasInlineIssues ? referenceLabels[index] : undefined;

    return {
      id: packetIds[index]!,
      referenceLabel: referenceLabels[index]!,
      title: issue.title,
      summary: buildPacketSummary(issue, input.constraints, inlineLabel),
      workspaceTargetPath: repoPath,
      branchTarget,
      runtime: input.runtime,
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
    } satisfies OrchestratorPacket;
  });

  const mission = normalizeOrchestratorMissionState({
    version: 2,
    missionId,
    prompt: buildMissionPrompt(loadedIssues, repoPath, input.constraints),
    summary: buildMissionSummary(loadedIssues, repoPath),
    repoPath,
    runtime: input.runtime,
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

  return {
    missionId,
    packets: persisted.packets.map((packet) => ({
      id: packet.id,
      title: packet.title,
      wave: waves.get(packet.id) ?? 1,
    })),
  };
}

export async function dispatchMission(input: DispatchMissionInput) {
  const before = currentMissionState();
  normalizeMissionSelection(before, input.missionId);

  // Use locked state to prevent race with headless loop tick
  const { result, state: finalState } = await withLockedState(async (current) => {
    const afterDispatch = await runDispatchTick(current);
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

export async function getMissionStatus(input: MissionStatusInput) {
  const state = currentMissionState();
  normalizeMissionSelection(state, input.missionId);

  const graph = buildDependencyGraph(state.packets);
  const dag = buildDagMetadata(state.packets);
  const packetById = new Map(state.packets.map((packet) => [packet.id, packet] as const));
  const agents = state.packets
    .map((packet) => {
      const lane = findLaneByPacket(packet.id);
      if (!lane) {
        return null;
      }

      return {
        packetId: packet.id,
        laneId: lane.id,
        sessionKey: lane.sessionKey,
        label: lane.label,
        runtime: lane.runtime,
        status: lane.status,
        branch: lane.branch,
        repoPath: lane.worktreePath ?? lane.repoPath,
        lastEventAt: lane.lastEventAt,
        lastEventLabel: lane.lastEventLabel,
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
      const lane = findLaneByPacket(node.packetId);
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
          lastEventAt: lane.lastEventAt,
          lastEventLabel: lane.lastEventLabel,
        } : packet.lane ?? null,
        review: packet.review ? {
          approved: packet.review.approved,
          findingsCount: packet.review.findings.length,
          summary: packet.review.summary,
          recordedAt: packet.review.recordedAt,
          auditApprovalId: packet.review.auditApprovalId ?? null,
        } : null,
      };
    }),
    agents,
    blockers,
    ...(cost ? { cost } : {}),
  };
}
