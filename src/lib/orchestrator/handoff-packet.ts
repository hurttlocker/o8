import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { listApprovalsForContext } from '@/lib/approvals/store';
import { getRuntimeRepoReview } from '@/lib/git/runtime-review';
import { getLane, getLaneEvents, listLanes } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { isOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { ChatHistoryMessage, OrchestratorHistoryRecord } from '@/lib/mobile/orchestrator-thread-projection';
import { safeOrchestratorHistoryPath } from '@/lib/mobile/orchestrator-thread-history';
import { autoCompactOrchestratorThread } from '@/lib/orchestrator/auto-compact';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { listMissionRegistryEntries } from '@/lib/orchestrator/mission-registry';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export const HANDOFF_PACKET_SCHEMA = 'o8/handoff.packet/v1' as const;
const GOVERNANCE_EVENT_LIMIT = 200;
export const HANDOFF_FULL_NARRATIVE_TOKEN_LIMIT = 48_000;
const HANDOFF_COMPACTION_TAIL_COUNT = 12;

export type HandoffCarry = 'full' | 'summary' | 'omitted';

export interface HandoffIntent {
  objective: string;
  constraints: string[];
  rejected: Array<{ approach: string; reason: string }>;
}

export interface BuildHandoffPacketInput {
  threadId: string;
  to: { backend: string; model: string | null };
  intent?: HandoffIntent;
  laneId?: string;
  verifiedClaims?: string[];
  unverifiedClaims?: string[];
  handoffId?: string;
  createdAt?: string;
  narrativeMode?: 'auto' | 'full' | 'compact';
  /** Internal launch-path exclusion when fallback selection follows persistence. */
  excludeMessageId?: string;
}

export interface HandoffPacket {
  schema: typeof HANDOFF_PACKET_SCHEMA;
  handoffId: string;
  createdAt: string;
  threadId: string;
  from: {
    backend: string | null;
    model: string | null;
    sessionKey: string | null;
    runtime: string | null;
  };
  to: { backend: string; model: string | null };
  carries: Record<'narrative' | 'intent' | 'workspace' | 'governance' | 'provenance', HandoffCarry>;
  narrative: {
    messages: Array<{
      role: 'user' | 'assistant';
      content: string;
      backend: string | null;
      model: string | null;
      actions?: Array<{
        description: string;
        status: 'completed' | 'failed' | 'incomplete' | 'unknown';
        sideEffect: 'read' | 'write' | 'meta' | 'unknown';
      }>;
    }>;
    seams: number[];
    tokenEstimate: number;
    compaction: {
      summary: string;
      fullNarrativeRef: string;
      archivedTurnCount: number;
      retainedTurnCount: number;
    } | null;
    compactedBy: {
      backend: string;
      model: string;
      reasoningEffort: string | null;
    } | null;
  };
  intent: HandoffIntent | null;
  workspace: {
    repoPath: string;
    branch: string;
    head: string;
    worktreePath: string;
    diffStat: string;
    touchedFiles: string[];
    dirty: boolean;
  } | null;
  governance: {
    packets: Array<{
      packetId: string;
      laneId: string;
      status: string;
      runtime: string;
      sessionKey: string | null;
      branch: string | null;
      worktreePath: string | null;
      attemptCount: number;
      maxAttempts: number | null;
    }>;
    approvals: Array<{
      id: string;
      status: string;
      risk: string;
      title: string;
      updatedAt: number;
    }>;
    laneStates: Array<{
      laneId: string;
      status: string;
      outcome: string | null;
      updatedAt: string;
    }>;
    events: Array<{
      verb: string;
      actor: string;
      timestamp: string;
    }>;
    eventsTruncated: boolean;
    retryBudget: {
      executionFailuresConsumed: number;
      limit: number | null;
      byPacket: Array<{
        packetId: string;
        attemptCount: number;
        maxAttempts: number | null;
        recoveryCount: number;
        typecheckAutoRetries: number;
        leaseWaitAutoRetries: number;
        stallRetries: number;
        launchAttempts: number;
      }>;
      note: string;
    };
  } | null;
  provenance: {
    sourceTurnCount: number;
    attributedAssistantTurns: number;
    unattributedAssistantTurns: number;
    verifiedClaims: string[];
    unverifiedClaims: string[];
    claimsClassified: boolean;
  };
}

export class HandoffPacketError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HandoffPacketError';
  }
}

function cleanText(value: string): string {
  return value.trim();
}

function cleanTextList(values: string[] | undefined): string[] {
  return (values ?? []).map(cleanText).filter(Boolean);
}

function normalizeIntent(value: HandoffIntent | undefined): HandoffIntent | null {
  if (!value) return null;
  const objective = cleanText(value.objective);
  const constraints = value.constraints.map(cleanText);
  const rejected = value.rejected.map((item) => ({
    approach: cleanText(item.approach),
    reason: cleanText(item.reason),
  }));
  if (!objective || constraints.some((constraint) => !constraint)
    || rejected.some((item) => !item.approach || !item.reason)
  ) {
    throw new HandoffPacketError(
      'Intent entries must be complete before the packet can claim to carry them.',
      'invalid_handoff_intent',
      400,
    );
  }
  return { objective, constraints, rejected };
}

async function readThreadRecord(threadId: string): Promise<OrchestratorHistoryRecord> {
  try {
    const raw = await readFile(safeOrchestratorHistoryPath(threadId), 'utf-8');
    const record = JSON.parse(raw) as OrchestratorHistoryRecord;
    if (!record || typeof record !== 'object') throw new Error('Invalid thread record');
    return record;
  } catch {
    throw new HandoffPacketError('The source thread does not exist.', 'handoff_thread_not_found', 404);
  }
}

function sourceFromMessages(
  messages: HandoffPacket['narrative']['messages'],
  record: OrchestratorHistoryRecord,
): HandoffPacket['from'] {
  const source = messages.findLast((message) => message.role === 'assistant');
  const backend = source?.backend ?? null;
  return {
    backend,
    model: source?.model ?? null,
    sessionKey: backend ? record.orchestratorSessionIds?.[backend] ?? null : null,
    runtime: null,
  };
}

function describedActions(
  message: ChatHistoryMessage,
): HandoffPacket['narrative']['messages'][number]['actions'] {
  const actions = message?.toolCalls?.map((tool) => {
    const sideEffect: 'read' | 'write' | 'meta' | 'unknown' = tool.sideEffectClass ?? 'unknown';
    const fallback = sideEffect === 'read'
      ? 'Inspected source workspace state.'
      : sideEffect === 'write'
        ? 'Changed source workspace state.'
        : sideEffect === 'meta'
          ? 'Updated source orchestration state.'
          : 'Performed a source-runtime action.';
    const description = tool.preview?.trim() || fallback;
    const status = tool.status === 'done'
      ? 'completed' as const
      : tool.status === 'error'
        ? 'failed' as const
        : tool.status === 'running' || tool.status === 'calling'
          ? 'incomplete' as const
          : 'unknown' as const;
    return { description, status, sideEffect };
  }).filter((action) => action.description);
  return actions && actions.length > 0 ? actions : undefined;
}

function narrativeFromRecord(
  record: OrchestratorHistoryRecord,
  excludeMessageId?: string,
): {
  messages: HandoffPacket['narrative']['messages'];
  seams: number[];
} {
  const messages: HandoffPacket['narrative']['messages'] = [];
  for (const message of record.messages ?? []) {
    if (excludeMessageId && message.id === excludeMessageId) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (typeof message.content !== 'string' || !message.content.trim()) continue;
    messages.push({
      role: message.role,
      content: message.content,
      backend: typeof message.backend === 'string' && message.backend ? message.backend : null,
      model: typeof message.model === 'string' && message.model ? message.model : null,
      actions: describedActions(message),
    });
  }

  const seams: number[] = [];
  let previous: { backend: string | null; model: string | null } | null = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || !message.backend) continue;
    if (previous?.backend && (previous.backend !== message.backend || previous.model !== message.model)) {
      seams.push(index);
    }
    previous = { backend: message.backend, model: message.model };
  }
  return { messages, seams };
}

function narrativeFromTranscript(entries: MobileTranscriptEntry[]): {
  messages: HandoffPacket['narrative']['messages'];
  seams: number[];
} {
  return narrativeFromRecord({
    messages: entries.map((entry) => ({
      id: entry.id,
      role: entry.role,
      content: entry.type === 'compaction' ? entry.compaction?.summary ?? entry.text : entry.text,
      timestamp: entry.timestamp,
      backend: entry.backend,
      model: entry.model,
      toolCalls: entry.toolCalls,
    })),
  });
}

async function buildWorkspace(
  repoPath: string,
  worktreePath: string,
): Promise<HandoffPacket['workspace']> {
  const review = await getRuntimeRepoReview(worktreePath);
  if (!review.branch || !review.head) return null;
  return {
    repoPath,
    branch: review.branch,
    head: review.head,
    worktreePath,
    diffStat: review.diffStat,
    touchedFiles: review.changedFiles.map((file) => file.path),
    dirty: review.dirty,
  };
}

function laneBelongsToWorkspace(
  lane: NonNullable<ReturnType<typeof getLane>>,
  repoPath: string,
): boolean {
  const canonical = (value: string) => {
    try {
      return realpathSync(value);
    } catch {
      return resolve(value);
    }
  };
  const expected = canonical(repoPath);
  return [lane.repoPath, lane.worktreePath]
    .filter((candidate): candidate is string => Boolean(candidate))
    .some((candidate) => canonical(candidate) === expected);
}

function resolveHandoffLane(
  laneId: string | undefined,
  repoPath: string,
): Lane | null {
  if (!laneId) return null;
  const lane = getLane(laneId);
  if (!lane) {
    throw new HandoffPacketError('The requested handoff lane does not exist.', 'handoff_lane_not_found', 404);
  }
  if (!laneBelongsToWorkspace(lane, repoPath)) {
    throw new HandoffPacketError(
      'The requested lane belongs to a different workspace.',
      'handoff_lane_workspace_mismatch',
      409,
    );
  }
  return lane;
}

function packetHasOpenObligation(packet: OrchestratorPacket): boolean {
  return !packet.archivedAt
    && packet.releaseState !== 'released'
    && packet.status !== 'archived'
    && packet.status !== 'failed';
}

function findThreadPackets(threadId: string): OrchestratorPacket[] {
  const states = [
    readOrchestratorControlPlaneState(),
    ...listMissionRegistryEntries({ includeArchived: false }).map((entry) => entry.mission),
  ];
  const packets = new Map<string, OrchestratorPacket>();
  for (const state of states) {
    for (const packet of state.packets) {
      if (packet.orchestratorThreadId !== threadId || !packetHasOpenObligation(packet)) continue;
      packets.set(packet.id, packet);
    }
  }
  return [...packets.values()];
}

function resolveGovernanceSources(
  threadId: string,
  explicitLane: Lane | null,
): { packets: OrchestratorPacket[]; lanes: Lane[] } {
  const packets = findThreadPackets(threadId);
  const packetById = new Map(packets.map((packet) => [packet.id, packet]));
  const lanesById = new Map<string, Lane>();
  for (const lane of listLanes()) {
    if (lane.packetId && packetById.has(lane.packetId)) lanesById.set(lane.id, lane);
  }
  if (explicitLane) lanesById.set(explicitLane.id, explicitLane);
  return { packets, lanes: [...lanesById.values()] };
}

function buildGovernance(
  packets: OrchestratorPacket[],
  lanes: Lane[],
): HandoffPacket['governance'] {
  if (packets.length === 0 && lanes.length === 0) return null;
  const packetById = new Map(packets.map((packet) => [packet.id, packet]));
  const eventWindows = lanes.flatMap((lane) => getLaneEvents(lane.id, GOVERNANCE_EVENT_LIMIT + 1));
  const eventsTruncated = eventWindows.length > GOVERNANCE_EVENT_LIMIT;
  const events = eventWindows
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-GOVERNANCE_EVENT_LIMIT);
  const approvals = lanes.flatMap((lane) => listApprovalsForContext({
    laneId: lane.id,
    packetId: lane.packetId ?? undefined,
    sessionKey: lane.sessionKey ?? undefined,
    projectId: lane.projectId,
  }));
  const approvalById = new Map(approvals.map((approval) => [approval.id, approval]));
  const packetRows: Array<{ packet: OrchestratorPacket | null; lane: Lane | null }> = packets
    .map((packet) => ({ packet, lane: lanes.find((candidate) => candidate.packetId === packet.id) ?? null }));
  for (const lane of lanes) {
    if (!lane.packetId || packetById.has(lane.packetId)) continue;
    packetRows.push({ packet: null, lane });
  }

  return {
    packets: packetRows.map(({ packet, lane }) => {
      return {
        packetId: packet?.id ?? lane?.packetId ?? '',
        laneId: lane?.id ?? '',
        status: lane?.status ?? packet?.status ?? 'unknown',
        runtime: lane?.runtime ?? packet?.runtime ?? 'unknown',
        sessionKey: lane?.sessionKey ?? null,
        branch: lane?.branch ?? packet?.branchTarget ?? null,
        worktreePath: lane?.worktreePath ?? packet?.workspaceTargetPath ?? null,
        attemptCount: packet?.attemptCount ?? 0,
        maxAttempts: packet?.maxAttempts ?? null,
      };
    }),
    approvals: [...approvalById.values()].map((approval) => ({
      id: approval.id,
      status: approval.status,
      risk: approval.risk,
      title: approval.title,
      updatedAt: approval.updatedAt,
    })),
    laneStates: lanes.map((lane) => ({
      laneId: lane.id,
      status: lane.status,
      outcome: lane.outcome ?? null,
      updatedAt: lane.updatedAt,
    })),
    events: events.map((event) => ({
      verb: event.verb,
      actor: event.actor,
      timestamp: event.timestamp,
    })),
    eventsTruncated,
    retryBudget: {
      executionFailuresConsumed: packetRows.reduce((total, { packet }) => total + (packet?.attemptCount ?? 0), 0),
      limit: packetRows.every(({ packet }) => typeof packet?.maxAttempts === 'number')
        ? packetRows.reduce((total, { packet }) => total + (packet?.maxAttempts ?? 0), 0)
        : null,
      byPacket: packetRows.map(({ packet, lane }) => ({
        packetId: packet?.id ?? lane?.packetId ?? '',
        attemptCount: packet?.attemptCount ?? 0,
        maxAttempts: packet?.maxAttempts ?? null,
        recoveryCount: packet?.recoveryCount ?? 0,
        typecheckAutoRetries: packet?.typecheckAutoRetries ?? 0,
        leaseWaitAutoRetries: packet?.leaseWaitAutoRetries ?? 0,
        stallRetries: packet?.stallRetries ?? 0,
        launchAttempts: packet?.launchAttempts ?? 0,
      })),
      note: 'Packet-scoped retry counters are carried unchanged; the handoff does not reset them.',
    },
  };
}

function estimateNarrativeTokens(messages: HandoffPacket['narrative']['messages']): number {
  const characters = messages.reduce((total, message) => total + message.content.length, 0);
  return Math.ceil(characters / 4);
}

export async function buildHandoffPacket(input: BuildHandoffPacketInput): Promise<HandoffPacket> {
  const threadId = cleanText(input.threadId);
  const to = {
    backend: cleanText(input.to.backend),
    model: typeof input.to.model === 'string' && input.to.model.trim()
      ? input.to.model.trim()
      : null,
  };
  if (!threadId || !to.backend) {
    throw new HandoffPacketError(
      'threadId and destination backend are required.',
      'invalid_handoff_request',
      400,
    );
  }
  if (!isOrchestratorBackendId(to.backend)) {
    throw new HandoffPacketError(
      'The destination backend is not registered.',
      'invalid_handoff_destination',
      400,
    );
  }

  const record = await readThreadRecord(threadId);
  const normalizedIntent = normalizeIntent(input.intent);
  const repoPath = typeof record.repoPath === 'string' ? record.repoPath.trim() : '';
  if (!repoPath) {
    throw new HandoffPacketError(
      'The source thread has no workspace identity.',
      'handoff_workspace_unknown',
      409,
    );
  }

  const fullNarrative = narrativeFromRecord(record, input.excludeMessageId);
  const messages = fullNarrative.messages;
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  if (assistantMessages.length === 0) {
    throw new HandoffPacketError(
      'The source thread has no completed assistant turn to hand off.',
      'handoff_thread_empty',
      409,
    );
  }

  const lane = resolveHandoffLane(input.laneId?.trim() || undefined, repoPath);
  const governanceSources = resolveGovernanceSources(threadId, lane);
  const workspaceLane = lane ?? governanceSources.lanes.find((candidate) => candidate.worktreePath) ?? null;
  const worktreePath = workspaceLane?.worktreePath ?? repoPath;
  const workspace = await buildWorkspace(workspaceLane?.repoPath ?? repoPath, worktreePath);
  const governance = buildGovernance(governanceSources.packets, governanceSources.lanes);
  const verifiedClaims = cleanTextList(input.verifiedClaims);
  const unverifiedClaims = cleanTextList(input.unverifiedClaims);
  const attributedAssistantTurns = assistantMessages.filter((message) => message.backend).length;
  const fullTokenEstimate = estimateNarrativeTokens(messages);
  const shouldCompact = input.narrativeMode === 'compact'
    || (input.narrativeMode !== 'full' && fullTokenEstimate > HANDOFF_FULL_NARRATIVE_TOKEN_LIMIT);
  let carriedNarrative = fullNarrative;
  let compaction: HandoffPacket['narrative']['compaction'] = null;
  let compactedBy: HandoffPacket['narrative']['compactedBy'] = null;
  if (shouldCompact) {
    const result = await autoCompactOrchestratorThread({
      repoPath,
      threadId,
      keepTailCount: HANDOFF_COMPACTION_TAIL_COUNT,
      trigger: 'handoff',
      force: true,
    });
    const summaryEntry = result.transcript.find((entry) => entry.type === 'compaction');
    const summary = summaryEntry?.compaction?.summary?.trim();
    if (!result.applied || !summary || !result.archiveRef || !result.compactedBy) {
      throw new HandoffPacketError(
        'The narrative exceeds the full-context limit and could not be compacted truthfully.',
        'handoff_compaction_failed',
        500,
      );
    }
    carriedNarrative = narrativeFromTranscript(result.transcript);
    compactedBy = result.compactedBy;
    compaction = {
      summary,
      fullNarrativeRef: result.archiveRef,
      archivedTurnCount: Math.max(0, messages.length - carriedNarrative.messages.length),
      retainedTurnCount: carriedNarrative.messages.length,
    };
  }

  return {
    schema: HANDOFF_PACKET_SCHEMA,
    handoffId: input.handoffId?.trim() || `handoff-${randomUUID()}`,
    createdAt: input.createdAt?.trim() || new Date().toISOString(),
    threadId,
    from: sourceFromMessages(messages, record),
    to,
    carries: {
      narrative: compaction ? 'summary' : 'full',
      intent: normalizedIntent ? 'full' : 'omitted',
      workspace: workspace ? 'full' : 'omitted',
      governance: governance ? 'summary' : 'omitted',
      provenance: 'summary',
    },
    narrative: {
      messages: carriedNarrative.messages,
      seams: carriedNarrative.seams,
      tokenEstimate: estimateNarrativeTokens(carriedNarrative.messages),
      compaction,
      compactedBy,
    },
    intent: normalizedIntent,
    workspace,
    governance,
    provenance: {
      sourceTurnCount: assistantMessages.length,
      attributedAssistantTurns,
      unattributedAssistantTurns: assistantMessages.length - attributedAssistantTurns,
      verifiedClaims,
      unverifiedClaims,
      claimsClassified: input.verifiedClaims !== undefined || input.unverifiedClaims !== undefined,
    },
  };
}
