import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createApproval, recordApprovalAudit, resolveApproval } from '@/lib/approvals/store';
import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { archiveLane, findLaneByPacket, listLanes } from '@/lib/lane/registry';
import { aggregateMissionCost } from '@/lib/orchestrator/cost-aggregator';
import {
  buildDomainLaneSummaries,
  readOrchestratorControlPlaneState,
  syncOrchestratorControlPlaneState,
  withLockedState,
  writeOrchestratorControlPlaneState,
} from '@/lib/orchestrator/control-plane';
import { buildDependencyGraph, buildDagMetadata } from '@/lib/orchestrator/dag';
import { runDispatchTick } from '@/lib/orchestrator/dispatch';
import { normalizeOrchestratorMissionState, reconcileOrchestratorMissionState } from '@/lib/orchestrator/store';
import { detectFileOverlaps, recommendMergeOrder } from '@/lib/worktree/conflicts';
import { getWorktreeManager } from '@/lib/worktree/launch';
import type { MergeOrderRecommendation } from '@/lib/worktree/conflicts';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type {
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorPacketReviewFinding,
  OrchestratorPacketReview,
  OrchestratorRuntime,
} from '@/lib/orchestrator/types';

const LOG_PREFIX = '[mcp-operator]';

export interface LoadedIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

export interface CreateMissionInput {
  issues: LoadedIssue[];
  repoPath: string;
  runtime: OrchestratorRuntime;
  constraints: string;
  /** When true, packets are chained sequentially (P2 after P1, etc.). Default: false (parallel). */
  sequential?: boolean;
}

export interface DispatchMissionInput {
  missionId?: string;
}

export interface MissionStatusInput {
  missionId?: string;
  includeCost: boolean;
}

export interface SubmitReviewInput {
  packetId: string;
  findings: OrchestratorReviewFinding[];
  approved: boolean;
}

export interface ApproveAndMergeInput {
  packetId: string;
  commitMessage?: string;
}

export interface PickComparisonWinnerInput {
  packetId: string;
  commitMessage?: string;
}

export interface ResetPacketInput {
  packetId: string;
  reason?: string;
  clearWorktree?: boolean;
}

function log(message: string, details?: unknown) {
  if (details === undefined) {
    console.log(`${LOG_PREFIX} ${message}`);
    return;
  }
  console.log(`${LOG_PREFIX} ${message}`, details);
}

function buildMissionId() {
  return `mission-${randomUUID().slice(0, 12)}`;
}

function buildPacketId() {
  return `pkt-${randomUUID()}`;
}

function slugify(value: string, maxLength = 48) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.slice(0, maxLength) || 'work';
}

/** Inline/ad-hoc issues use synthetic numbers starting at 90001 and have no URL. */
function isInlineIssue(issue: LoadedIssue) {
  return !issue.url && issue.number >= 90001;
}

function ensureRepoPath(repoPath: string) {
  const normalized = repoPath.trim();
  if (!normalized) {
    throw new Error('repoPath is required.');
  }
  if (!existsSync(normalized) || !statSync(normalized).isDirectory()) {
    throw new Error(`Repository path not found: ${normalized}`);
  }
  return normalized;
}

function normalizeLoadedIssue(issue: LoadedIssue, index: number): LoadedIssue {
  if (!Number.isInteger(issue.number) || issue.number < 1) {
    throw new Error(`issues[${index}] must include a positive issue number.`);
  }

  const title = typeof issue.title === 'string' ? issue.title.trim() : '';
  if (!title) {
    throw new Error(`issues[${index}] must include a title.`);
  }

  return {
    number: issue.number,
    title,
    body: typeof issue.body === 'string' ? issue.body : '',
    url: typeof issue.url === 'string' ? issue.url : '',
  };
}

function extractIssueDependencies(body: string, availableIssueNumbers: Set<number>) {
  const dependencies = new Set<number>();
  const patterns = [
    /(?:depends on|blocked by|after|requires)\s+(?:https?:\/\/[^\s/]+\/[^/\s]+\/[^/\s]+\/issues\/|#)?(\d+)/gi,
    /(?:depends on|blocked by|after|requires)\s+issue\s+#?(\d+)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      const numberValue = Number.parseInt(match[1] ?? '', 10);
      if (Number.isFinite(numberValue) && availableIssueNumbers.has(numberValue)) {
        dependencies.add(numberValue);
      }
    }
  }

  return [...dependencies];
}

function buildMissionPrompt(issues: LoadedIssue[], repoPath: string, constraints: string) {
  const repoName = basename(repoPath);
  const hasInline = issues.some(isInlineIssue);
  return [
    `Sprint mission for ${repoName}.`,
    '',
    hasInline ? 'Tasks:' : 'Issues:',
    ...issues.map((issue, index) =>
      isInlineIssue(issue)
        ? `- inline-${index + 1}: ${issue.title}`
        : `- #${issue.number}: ${issue.title}`,
    ),
    constraints ? '' : null,
    constraints ? `Constraints: ${constraints}` : null,
  ].filter((value): value is string => Boolean(value)).join('\n');
}

function buildMissionSummary(issues: LoadedIssue[], repoPath: string) {
  const repoName = basename(repoPath);
  const hasInline = issues.some(isInlineIssue);
  const noun = hasInline ? 'task' : 'issue';
  return `Sprint mission for ${repoName} with ${issues.length} ${noun}${issues.length === 1 ? '' : 's'}.`;
}

function buildPacketSummary(issue: LoadedIssue, constraints: string, inlineLabel?: string) {
  const header = isInlineIssue(issue)
    ? `Task${inlineLabel ? ` ${inlineLabel}` : ''}: ${issue.title}`
    : `GitHub issue #${issue.number}: ${issue.title}`;
  return [
    header,
    issue.body.trim() || (isInlineIssue(issue) ? 'No description provided.' : 'No issue body provided.'),
    constraints ? `Constraints: ${constraints}` : null,
  ].filter((value): value is string => Boolean(value)).join('\n\n');
}

function normalizeMissionSelection(state: OrchestratorMissionState, missionId?: string) {
  const requestedMissionId = missionId?.trim();
  if (!requestedMissionId) {
    return;
  }

  const currentMissionId = state.missionId?.trim() ?? '';
  if (!currentMissionId) {
    throw new Error(`No active mission is stored. Requested ${requestedMissionId}.`);
  }
  if (currentMissionId !== requestedMissionId) {
    throw new Error(`Mission mismatch. Current mission is ${currentMissionId}, requested ${requestedMissionId}.`);
  }
}

function highestReviewRisk(findings: OrchestratorPacketReviewFinding[]) {
  if (findings.some((finding) => finding.severity === 'high')) {
    return 'high';
  }
  if (findings.some((finding) => finding.severity === 'warning')) {
    return 'medium';
  }
  return 'low';
}

function buildReviewSummary(findings: OrchestratorReviewFinding[], approved: boolean) {
  const verdict = approved ? 'Approved' : 'Changes requested';
  if (findings.length === 0) {
    return `${verdict}. No findings recorded.`;
  }

  const topFindings = findings
    .slice(0, 3)
    .map((finding) => {
      const location = typeof finding.line === 'number' ? `${finding.file}:${finding.line}` : finding.file;
      return `${location} [${finding.severity}/${finding.resolution}] ${finding.description}`;
    })
    .join(' | ');

  return `${verdict}. ${findings.length} finding${findings.length === 1 ? '' : 's'}: ${topFindings}`;
}

function buildPacketReview(
  findings: OrchestratorReviewFinding[],
  approved: boolean,
  summary: string,
  auditApprovalId?: string | null,
): OrchestratorPacketReview {
  return {
    approved,
    findings: findings.map((finding) => ({
      file: finding.file,
      line: finding.line ?? null,
      severity: finding.severity === 'bug'
        ? 'high'
        : finding.severity === 'rule_violation'
          ? 'warning'
          : 'info',
      description: finding.description,
      resolution: finding.resolution,
    })),
    recordedAt: new Date().toISOString(),
    summary,
    auditApprovalId: auditApprovalId?.trim() || null,
  };
}

function mapReviewSummary(packet: OrchestratorPacket) {
  const review = packet.review;
  if (!review) {
    return undefined;
  }
  const risk = highestReviewRisk(review.findings);
  return `${review.summary} Risk: ${risk}.`;
}

function currentMissionState() {
  const current = normalizeOrchestratorMissionState(readOrchestratorControlPlaneState());
  return reconcileOrchestratorMissionState(current, {
    laneSnapshots: [],
    runtimeTruth: [],
    domainLanes: buildDomainLaneSummaries(),
  });
}

function deriveApprovalRisk(findings: OrchestratorReviewFinding[], approved: boolean) {
  if (!approved) {
    return 'high' as const;
  }
  if (findings.some((finding) => finding.severity === 'bug')) {
    return 'high' as const;
  }
  if (findings.length > 0) {
    return 'medium' as const;
  }
  return 'low' as const;
}

function recordPacketReviewAudit(packet: OrchestratorPacket, findings: OrchestratorReviewFinding[], approved: boolean, summary: string) {
  const lane = findLaneByPacket(packet.id);
  const approval = createApproval({
    source: 'runtime',
    runtime: lane?.runtime ?? packet.runtime,
    agent: lane?.label ?? packet.title,
    sessionKey: lane?.sessionKey || `packet:${packet.id}`,
    title: 'Orchestrator review',
    description: summary,
    summary: `Orchestrator review for ${packet.referenceLabel}`,
    toolName: 'orchestrator_review',
    args: {
      packetId: packet.id,
      approved,
      findings,
    },
    risk: deriveApprovalRisk(findings, approved),
    metadata: {
      Packet: packet.id,
      ...(lane ? { Lane: lane.id, Branch: lane.branch, Base: lane.baseBranch } : {}),
    },
  });
  recordApprovalAudit(approval.id, 'orchestrator_review', 'system', summary);
  const resolved = resolveApproval(approval.id, approved ? 'approve' : 'reject', 'system', summary);
  return resolved?.id ?? approval.id;
}

function missionAgentKeys(packetIds: Set<string>) {
  return listLanes()
    .filter((lane) => lane.packetId && packetIds.has(lane.packetId))
    .filter((lane) => lane.status !== 'completed' && lane.status !== 'archived')
    .map((lane) => lane.sessionKey || lane.id);
}

type ActivePacketLane = NonNullable<ReturnType<typeof findLaneByPacket>>;

interface MergeOrderCandidate {
  packet: OrchestratorPacket;
  lane: ActivePacketLane;
  worktree: WorktreeInfo;
}

interface OrderedMergeCandidate extends MergeOrderCandidate {
  recommendation: MergeOrderRecommendation;
}

function isPacketAwaitingMerge(packet: OrchestratorPacket) {
  return packet.status === 'awaiting_review'
    && packet.releaseState !== 'released'
    && packet.review?.approved !== false;
}

async function getWaveMergeOrder(
  state: OrchestratorMissionState,
  packetId: string,
): Promise<OrderedMergeCandidate[] | null> {
  const graph = buildDependencyGraph(state.packets);
  const packetById = new Map(state.packets.map((packet) => [packet.id, packet] as const));
  const targetNode = graph.find((node) => node.packetId === packetId);
  if (!targetNode) {
    return null;
  }

  const targetPacket = packetById.get(packetId);
  const repoPath = state.repoPath ?? targetPacket?.workspaceTargetPath ?? null;
  if (!repoPath) {
    return null;
  }

  const sameWavePackets = graph
    .filter((node) => node.wave === targetNode.wave)
    .map((node) => packetById.get(node.packetId))
    .filter((packet): packet is OrchestratorPacket => packet !== undefined && isPacketAwaitingMerge(packet));

  if (sameWavePackets.length <= 1) {
    return null;
  }

  const worktrees = await getWorktreeManager(repoPath).list();
  const worktreeByPath = new Map(worktrees.map((worktree) => [worktree.path, worktree] as const));
  const candidates = sameWavePackets.flatMap((packet) => {
    const lane = findLaneByPacket(packet.id);
    if (!lane?.worktreePath) {
      return [];
    }

    const worktree = worktreeByPath.get(lane.worktreePath);
    if (!worktree) {
      return [];
    }

    return [{ packet, lane, worktree }];
  });

  if (candidates.length <= 1) {
    return null;
  }

  const candidateWorktrees = candidates.map((candidate) => candidate.worktree);
  const overlaps = detectFileOverlaps(candidateWorktrees);
  const recommendations = await recommendMergeOrder(candidateWorktrees, overlaps);
  const candidateByWorktreeId = new Map(candidates.map((candidate) => [candidate.worktree.id, candidate] as const));

  const ordered = recommendations.flatMap((recommendation) => {
    const candidate = candidateByWorktreeId.get(recommendation.worktreeId);
    return candidate ? [{ ...candidate, recommendation }] : [];
  });

  if (ordered.length <= 1) {
    return null;
  }

  console.log('[merge-order]', {
    wave: targetNode.wave,
    requestedPacketId: packetId,
    sequence: ordered.map(({ packet, worktree, recommendation }) => ({
      position: recommendation.position,
      packetId: packet.id,
      referenceLabel: packet.referenceLabel,
      title: packet.title,
      worktreeId: worktree.id,
      agentType: recommendation.agentType,
      fileCount: recommendation.fileCount,
      totalChanges: recommendation.totalChanges,
      reason: recommendation.reason,
    })),
  });

  return ordered;
}

export interface MergePacketResult { merged: boolean; note: string; approvalId?: string }

async function approveAndMergeSinglePacket(input: ApproveAndMergeInput): Promise<MergePacketResult> {
  const state = currentMissionState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  if (!packet) {
    // #557 — Fall through to lane-only merge when the mission packet is missing.
    const { mergeOrphanLaneByPacket } = await import('./orphan-lane-merge');
    return mergeOrphanLaneByPacket(input.packetId, input.commitMessage);
  }

  if (packet.review && !packet.review.approved) {
    return {
      merged: false,
      note: 'Packet review is not approved. Resolve findings before merging.',
    };
  }

  const lane = findLaneByPacket(packet.id);
  if (!lane) {
    throw new Error(`Packet ${packet.id} is not bound to an active lane.`);
  }

  const result = await dispatchLaneCommand({
    verb: 'merge',
    laneId: lane.id,
    commitMessage: input.commitMessage?.trim() || undefined,
    reviewSummary: mapReviewSummary(packet),
    orchestratorReviewed: packet.review?.approved === true,
    actor: 'orchestrator',
  });

  // Sync first so reconciliation runs, then apply the release on top.
  // This prevents reconciliation from resetting the packet status after we set it.
  // Pass undefined so sync re-reads inside the mutex — otherwise we race the
  // /api/orchestrator/state GET poll and other concurrent writers.
  const synced = await syncOrchestratorControlPlaneState();

  if (result.ok) {
    for (const packetState of synced.packets) {
      if (packetState.id === input.packetId) {
        packetState.status = 'released';
        packetState.queueState = 'held';
        packetState.releaseState = 'released';
        packetState.blockedReason = null;
        if (packetState.lane) {
          packetState.lane.lastEventLabel = 'merged';
        }
        break;
      }
    }
  }

  const afterDispatch = await runDispatchTick(synced);
  writeOrchestratorControlPlaneState(afterDispatch);

  log(`Merge command finished for packet ${packet.id}.`, {
    ok: result.ok,
    approvalId: result.approvalId ?? null,
  });

  return {
    merged: result.ok,
    note: result.note,
    ...(result.approvalId ? { approvalId: result.approvalId } : {}),
  };
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

export async function submitPacketReview(input: SubmitReviewInput) {
  const state = currentMissionState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  if (!packet) {
    throw new Error(`Packet ${input.packetId} not found.`);
  }

  const summary = buildReviewSummary(input.findings, input.approved);
  const auditApprovalId = recordPacketReviewAudit(packet, input.findings, input.approved, summary);

  const finalState = writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState({
    ...state,
    packets: state.packets.map((candidate) => candidate.id === packet.id
      ? {
          ...candidate,
          review: buildPacketReview(input.findings, input.approved, summary, auditApprovalId),
        }
      : candidate),
  }));

  log(`Recorded review for packet ${packet.id}.`, {
    approved: input.approved,
    findings: input.findings.length,
    reviewEventType: 'orchestrator_review',
  });

  return {
    recorded: true,
    findingsCount: input.findings.length,
    auditEventType: 'orchestrator_review',
    auditApprovalId: finalState.packets.find((candidate) => candidate.id === packet.id)?.review?.auditApprovalId ?? null,
  };
}

export async function approveAndMergePacket(input: ApproveAndMergeInput) {
  const state = currentMissionState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  // #557 — Missing packet falls through to single-packet merge (lane fallback).
  if (!packet) return approveAndMergeSinglePacket(input);

  const orderedWavePackets = await getWaveMergeOrder(state, packet.id);
  if (!orderedWavePackets) {
    return approveAndMergeSinglePacket(input);
  }

  const targetIndex = orderedWavePackets.findIndex((candidate) => candidate.packet.id === packet.id);
  if (targetIndex === -1) {
    return approveAndMergeSinglePacket(input);
  }

  const mergeSequence = orderedWavePackets.slice(0, targetIndex + 1);
  const mergedPrerequisites: string[] = [];
  let requestedResult: MergePacketResult | null = null;

  for (const candidate of mergeSequence) {
    const result = await approveAndMergeSinglePacket({
      packetId: candidate.packet.id,
      commitMessage: candidate.packet.id === packet.id ? input.commitMessage : undefined,
    });

    if (!result.merged) {
      return {
        merged: false,
        note: candidate.packet.id === packet.id
          ? result.note
          : `Merge order requires ${candidate.packet.referenceLabel} to merge before ${packet.referenceLabel}: ${result.note}`,
        ...(result.approvalId ? { approvalId: result.approvalId } : {}),
      };
    }

    if (candidate.packet.id !== packet.id) {
      mergedPrerequisites.push(candidate.packet.referenceLabel);
      continue;
    }

    requestedResult = result;
  }

  if (!requestedResult) {
    return {
      merged: false,
      note: `Packet ${packet.referenceLabel} was not included in the recommended merge sequence.`,
    };
  }

  return {
    merged: true,
    note: mergedPrerequisites.length > 0
      ? `Merged ${mergedPrerequisites.join(', ')} before ${packet.referenceLabel} based on recommended same-wave merge order. ${requestedResult.note}`
      : requestedResult.note,
  };
}

export async function pickComparisonWinner(input: PickComparisonWinnerInput) {
  const state = currentMissionState();
  const winner = state.packets.find((candidate) => candidate.id === input.packetId);
  if (!winner) {
    throw new Error(`Packet ${input.packetId} not found.`);
  }

  const comparisonGroupId = winner.comparisonGroupId?.trim();
  if (!comparisonGroupId) {
    throw new Error(`Packet ${winner.id} is not part of a comparison group.`);
  }

  const comparisonPackets = state.packets.filter((packet) => packet.comparisonGroupId === comparisonGroupId);
  if (comparisonPackets.length < 2) {
    throw new Error(`Comparison group ${comparisonGroupId} has no alternate candidates to compare.`);
  }

  const archivedPacketIds = comparisonPackets
    .filter((packet) => packet.id !== winner.id)
    .map((packet) => packet.id);
  const archivedAt = new Date().toISOString();

  await withLockedState(async (current) => {
    const activeComparisonGroups = new Set(current.activeComparisonGroups ?? []);
    activeComparisonGroups.delete(comparisonGroupId);
    current.activeComparisonGroups = [...activeComparisonGroups];

    for (const packet of current.packets) {
      if (packet.comparisonGroupId !== comparisonGroupId) {
        continue;
      }

      if (packet.id === winner.id) {
        packet.lastEventAt = archivedAt;
        packet.lastEventLabel = 'comparison_winner_selected';
        if (packet.lane) {
          packet.lane.lastEventAt = archivedAt;
          packet.lane.lastEventLabel = 'comparison_winner_selected';
        }
        continue;
      }

      packet.archivedAt = archivedAt;
      packet.status = 'archived';
      packet.queueState = 'held';
      packet.blockedReason = null;
      packet.lastEventAt = archivedAt;
      packet.lastEventLabel = 'comparison_loser_archived';
      if (packet.lane) {
        packet.lane.lastEventAt = archivedAt;
        packet.lane.lastEventLabel = 'comparison_loser_archived';
      }

      if (packet.lane?.laneId) {
        archiveLane(packet.lane.laneId, 'user');
      }
    }
  });

  const mergeResult = await approveAndMergePacket({
    packetId: winner.id,
    commitMessage: input.commitMessage,
  });

  return {
    ...mergeResult,
    groupId: comparisonGroupId,
    archivedPacketIds,
  };
}

export async function resetPacket(input: ResetPacketInput) {
  const state = currentMissionState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  if (!packet) {
    throw new Error(`Packet ${input.packetId} not found.`);
  }

  // Archive the old lane and clear its packet binding so the reconciler
  // doesn't re-attach it to this packet
  let worktreePath: string | null = null;
  if (packet.lane?.laneId) {
    try {
      const { archiveLane, findLaneByPacket: findLane, updateLane } = await import('@/lib/lane/registry');
      const lane = findLane(packet.id);
      worktreePath = lane?.worktreePath ?? null;
      // Clear packetId first so reconciler won't find this lane
      updateLane(packet.lane.laneId, { packetId: '' });
      archiveLane(packet.lane.laneId, 'user');
      log(`Archived stale lane ${packet.lane.laneId} for packet ${packet.referenceLabel}`);
    } catch {
      log(`Could not archive lane ${packet.lane.laneId} — may already be gone`);
    }
  }

  // If clearWorktree requested, prune the old worktree directory
  let worktreePruned = false;
  if (input.clearWorktree && worktreePath && state.repoPath) {
    try {
      const manager = await getWorktreeManager(state.repoPath);
      const worktrees = await manager.list();
      const match = worktrees.find((wt) => worktreePath!.includes(wt.id));
      if (match) {
        await manager.cleanup(match.id, { force: true, deleteBranch: true });
        worktreePruned = true;
        log(`[lane-reset] Pruned worktree ${match.id} for packet ${packet.referenceLabel}`);
      }
    } catch {
      log(`[lane-reset] Could not prune worktree at ${worktreePath} — may already be gone`);
    }
  }

  // Reset packet to dispatchable state
  // #455 — lane MUST be null, not a blank object. A truthy lane with empty laneId
  // causes the reconciler to see "has lane but no domain match" → 'recovering',
  // which races the next dispatch tick and traps the packet in a recovery loop.
  packet.status = 'draft';
  packet.queueState = 'queued';
  packet.releaseState = 'pending';
  packet.blockedReason = null;
  packet.lane = null;
  packet.review = null;
  packet.lastEventAt = null;
  packet.lastEventLabel = null;
  // #455 — Clear recovery counter so a manual reset gives fresh retry budget
  packet.recoveryCount = 0;
  packet.lastRecoveryAt = null;

  // Persist
  const { updateOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  updateOrchestratorMissionState(state);
  log(`Reset packet ${packet.referenceLabel} (${input.packetId}). Reason: ${input.reason ?? 'operator reset'}`);

  return {
    reset: true,
    packetId: input.packetId,
    referenceLabel: packet.referenceLabel,
    worktreePruned,
    note: `Packet ${packet.referenceLabel} reset to queued/draft. Old lane archived.${worktreePruned ? ' Worktree pruned.' : ''} Ready for re-dispatch.`,
  };
}
