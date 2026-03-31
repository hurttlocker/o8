import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { createApproval, recordApprovalAudit, resolveApproval } from '@/lib/approvals/store';
import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { findLaneByPacket, listLanes } from '@/lib/lane/registry';
import { aggregateMissionCost } from '@/lib/orchestrator/cost-aggregator';
import {
  buildDomainLaneSummaries,
  readOrchestratorControlPlaneState,
  syncOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} from '@/lib/orchestrator/control-plane';
import { buildDependencyGraph, buildDagMetadata } from '@/lib/orchestrator/dag';
import { runDispatchTick } from '@/lib/orchestrator/dispatch';
import { normalizeOrchestratorMissionState, reconcileOrchestratorMissionState } from '@/lib/orchestrator/store';
import type {
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorPacketReviewFinding,
  OrchestratorPacketReview,
  OrchestratorRuntime,
} from '@/lib/orchestrator/types';

const execFileAsync = promisify(execFile);
const GH_MAX_BUFFER = 10 * 1024 * 1024;
const LOG_PREFIX = '[mcp-operator]';

interface LoadedIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

interface CreateMissionInput {
  issues: string[];
  repoPath: string;
  runtime: OrchestratorRuntime;
  constraints: string;
}

interface DispatchMissionInput {
  missionId?: string;
}

interface MissionStatusInput {
  missionId?: string;
  includeCost: boolean;
}

interface SubmitReviewInput {
  packetId: string;
  findings: OrchestratorReviewFinding[];
  approved: boolean;
}

interface ApproveAndMergeInput {
  packetId: string;
  commitMessage?: string;
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

function normalizeIssueRef(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return '';
  }

  const urlMatch = normalized.match(/\/issues\/(\d+)(?:\/)?$/i);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  const hashMatch = normalized.match(/^#?(\d+)$/);
  if (hashMatch?.[1]) {
    return hashMatch[1];
  }

  return normalized;
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
  return [
    `Sprint mission for ${repoName}.`,
    '',
    'Issues:',
    ...issues.map((issue) => `- #${issue.number}: ${issue.title}`),
    constraints ? '' : null,
    constraints ? `Constraints: ${constraints}` : null,
  ].filter((value): value is string => Boolean(value)).join('\n');
}

function buildMissionSummary(issues: LoadedIssue[], repoPath: string) {
  const repoName = basename(repoPath);
  return `Sprint mission for ${repoName} with ${issues.length} issue${issues.length === 1 ? '' : 's'}.`;
}

function buildPacketSummary(issue: LoadedIssue, constraints: string) {
  return [
    `GitHub issue #${issue.number}: ${issue.title}`,
    issue.body.trim() || 'No issue body provided.',
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

async function loadIssue(repoPath: string, issueRef: string): Promise<LoadedIssue> {
  const normalizedIssueRef = normalizeIssueRef(issueRef);
  if (!normalizedIssueRef) {
    throw new Error('Issue references must be non-empty.');
  }

  const { stdout } = await execFileAsync(
    'gh',
    ['issue', 'view', normalizedIssueRef, '--json', 'number,title,body,url'],
    { cwd: repoPath, maxBuffer: GH_MAX_BUFFER },
  );

  const parsed = JSON.parse(stdout) as Partial<LoadedIssue>;
  if (typeof parsed.number !== 'number' || typeof parsed.title !== 'string') {
    throw new Error(`Unable to load issue ${normalizedIssueRef}.`);
  }

  return {
    number: parsed.number,
    title: parsed.title,
    body: typeof parsed.body === 'string' ? parsed.body : '',
    url: typeof parsed.url === 'string' ? parsed.url : '',
  };
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

export async function createMission(input: CreateMissionInput) {
  const repoPath = ensureRepoPath(input.repoPath);
  const loadedIssues = await Promise.all(input.issues.map((issueRef) => loadIssue(repoPath, issueRef)));
  const availableIssueNumbers = new Set(loadedIssues.map((issue) => issue.number));
  const explicitDependencies = loadedIssues.map((issue) => (
    extractIssueDependencies(issue.body, availableIssueNumbers).filter((dependency) => dependency !== issue.number)
  ));
  const hasExplicitDependencies = explicitDependencies.some((dependencies) => dependencies.length > 0);

  const missionId = buildMissionId();
  const packetIds = loadedIssues.map(() => buildPacketId());
  const referenceLabels = loadedIssues.map((_, index) => `P${index + 1}`);
  const packetIdByIssueNumber = new Map(loadedIssues.map((issue, index) => [issue.number, packetIds[index] as string]));
  const referenceLabelByIssueNumber = new Map(loadedIssues.map((issue, index) => [issue.number, referenceLabels[index] as string]));

  const packets = loadedIssues.map((issue, index) => {
    const dependencyNumbers = explicitDependencies[index].length > 0
      ? explicitDependencies[index]
      : !hasExplicitDependencies && index > 0
        ? [loadedIssues[index - 1]!.number]
        : [];

    return {
      id: packetIds[index]!,
      referenceLabel: referenceLabels[index]!,
      title: issue.title,
      summary: buildPacketSummary(issue, input.constraints),
      workspaceTargetPath: repoPath,
      branchTarget: `issue/${issue.number}-${slugify(issue.title)}`,
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

  const reconciled = reconcileOrchestratorMissionState(mission, {
    laneSnapshots: [],
    runtimeTruth: [],
    domainLanes: buildDomainLaneSummaries(),
  });
  const persisted = writeOrchestratorControlPlaneState(reconciled);
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

  const synced = await syncOrchestratorControlPlaneState(before);
  const afterDispatch = await runDispatchTick(synced);
  const finalState = writeOrchestratorControlPlaneState(afterDispatch);
  const beforeByPacketId = new Map(before.packets.map((packet) => [packet.id, packet] as const));
  const dispatched = finalState.packets.filter((packet) => {
    const previous = beforeByPacketId.get(packet.id);
    const hadLane = Boolean(previous?.lane?.laneId || previous?.lane?.sessionKey);
    const hasLane = Boolean(packet.lane?.laneId || packet.lane?.sessionKey);
    return !hadLane && hasLane;
  }).length;
  const packetIds = new Set(finalState.packets.map((packet) => packet.id));
  const dag = buildDagMetadata(finalState.packets);

  log(`Dispatched mission ${finalState.missionId || 'current'} with ${dispatched} packet launches.`);

  return {
    dispatched,
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

function parseWorktreeEntries(porcelainOutput: string) {
  return porcelainOutput.split('\n\n').map((entry) => {
    const lines = entry.split('\n');
    const wtPath = lines.find((l) => l.startsWith('worktree '))?.replace('worktree ', '').trim() ?? '';
    const branchLine = lines.find((l) => l.startsWith('branch '));
    const wtBranch = branchLine?.replace('branch refs/heads/', '').trim() ?? null;
    return { path: wtPath, branch: wtBranch };
  }).filter((wt) => wt.path && wt.branch);
}

async function directBranchMerge(
  repoPath: string,
  branchHint: string,
  commitMessage?: string,
): Promise<{ ok: boolean; note: string; approvalId?: string }> {
  try {
    const worktrees = parseWorktreeEntries(
      (await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath })).stdout,
    );

    // Resolve the actual branch: try exact match first, then fuzzy match
    // against worktree branches (worktree naming may differ from packet branchTarget).
    let branch = branchHint;
    let worktreePath: string | null = null;

    const exact = worktrees.find((wt) => wt.branch === branchHint);
    if (exact) {
      worktreePath = exact.path;
    } else {
      // Fuzzy: find a worktree branch that contains the packet slug
      // e.g. branchHint "issue/339-chore-sprint-6..." matches
      //      "worktree/codex/packet-chore-sprint-6..."
      const slug = branchHint.replace(/^issue\/\d+-/, '').slice(0, 40);
      const fuzzy = worktrees.find((wt) =>
        wt.path !== repoPath && wt.branch && wt.branch.includes(slug),
      );
      if (fuzzy?.branch) {
        branch = fuzzy.branch;
        worktreePath = fuzzy.path;
        log(`Resolved branch hint '${branchHint}' → actual branch '${branch}' via worktree fuzzy match`);
      }
    }

    // Commit any uncommitted work in the worktree
    if (worktreePath && worktreePath !== repoPath) {
      if (commitMessage) {
        try {
          await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
          await execFileAsync('git', ['commit', '-m', commitMessage, '--allow-empty'], { cwd: worktreePath });
        } catch { /* nothing to commit */ }
      }
    }

    // Verify branch exists
    try {
      await execFileAsync('git', ['rev-parse', '--verify', branch], { cwd: repoPath });
    } catch {
      return { ok: false, note: `Branch '${branch}' does not exist. Cannot merge.` };
    }

    // Merge the branch into main
    const savedBranch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath })).stdout.trim();
    await execFileAsync('git', ['checkout', 'main'], { cwd: repoPath });
    try {
      const mergeMsg = commitMessage
        ? `Merge lane: ${commitMessage}`
        : `Merge branch '${branch}'`;
      await execFileAsync('git', ['merge', '--no-ff', '-m', mergeMsg, branch], { cwd: repoPath });
    } catch (mergeErr) {
      try { await execFileAsync('git', ['merge', '--abort'], { cwd: repoPath }); } catch { /* already clean */ }
      await execFileAsync('git', ['checkout', savedBranch], { cwd: repoPath });
      const message = mergeErr instanceof Error ? mergeErr.message : 'Merge failed.';
      return { ok: false, note: `Direct merge failed: ${message}` };
    }
    await execFileAsync('git', ['checkout', savedBranch], { cwd: repoPath });

    log(`Direct branch merge succeeded: ${branch} → main`);
    return { ok: true, note: `Merged ${branch} into main (direct fallback).` };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Direct merge failed.';
    return { ok: false, note: message };
  }
}

export async function approveAndMergePacket(input: ApproveAndMergeInput) {
  const state = currentMissionState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  if (!packet) {
    throw new Error(`Packet ${input.packetId} not found.`);
  }

  if (packet.review && !packet.review.approved) {
    return {
      merged: false,
      note: 'Packet review is not approved. Resolve findings before merging.',
    };
  }

  const lane = findLaneByPacket(packet.id);
  const laneId = lane?.id ?? packet.lane?.laneId ?? null;

  let result: { ok: boolean; note: string; approvalId?: string };

  if (laneId) {
    result = await dispatchLaneCommand({
      verb: 'merge',
      laneId,
      commitMessage: input.commitMessage?.trim() || undefined,
      reviewSummary: mapReviewSummary(packet),
      actor: 'orchestrator',
    });
  } else {
    // Lane binding lost (e.g. MCP restart clobbered the registry). Fall back to
    // direct worktree merge using the packet's branch target.
    const branchTarget = packet.branchTarget;
    const repoPath = packet.workspaceTargetPath;
    if (!branchTarget || !repoPath) {
      throw new Error(`Packet ${packet.id} has no lane binding and no branch target for fallback merge.`);
    }
    log(`Lane binding lost for packet ${packet.id}, falling back to direct branch merge: ${branchTarget}`);
    result = await directBranchMerge(repoPath, branchTarget, input.commitMessage?.trim());
  }

  // After a successful merge, mark the packet as completed+released so downstream
  // packets in the DAG can unblock and dispatch automatically.
  const currentState = readOrchestratorControlPlaneState();
  if (result.ok) {
    for (const p of currentState.packets) {
      if (p.id === input.packetId) {
        p.status = 'released';
        p.queueState = 'held';
        p.releaseState = 'released';
        p.blockedReason = null;
        if (p.lane) {
          p.lane.lastEventLabel = 'merged';
        }
        break;
      }
    }
  }

  const synced = await syncOrchestratorControlPlaneState(currentState);
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
