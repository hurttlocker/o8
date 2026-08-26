import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { listApprovalsForContext } from '@/lib/approvals/store';
import { getRuntimeRepoReview } from '@/lib/git/runtime-review';
import { getLane, getLaneEvents } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { isOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { OrchestratorHistoryRecord } from '@/lib/mobile/orchestrator-thread-projection';
import { safeOrchestratorHistoryPath } from '@/lib/mobile/orchestrator-thread-history';

export const HANDOFF_PACKET_SCHEMA = 'o8/handoff.packet/v1' as const;
const GOVERNANCE_EVENT_LIMIT = 200;

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
    }>;
    seams: number[];
    tokenEstimate: number;
    compactedBy: null;
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
      executionFailuresConsumed: null;
      limit: null;
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

function buildGovernance(lane: Lane | null): HandoffPacket['governance'] {
  if (!lane) return null;
  const eventWindow = getLaneEvents(lane.id, GOVERNANCE_EVENT_LIMIT + 1);
  const eventsTruncated = eventWindow.length > GOVERNANCE_EVENT_LIMIT;
  const events = eventWindow.slice(eventsTruncated ? 1 : 0);
  const approvals = listApprovalsForContext({
    laneId: lane.id,
    packetId: lane.packetId ?? undefined,
    sessionKey: lane.sessionKey ?? undefined,
    projectId: lane.projectId,
  });

  return {
    packets: lane.packetId ? [{
      packetId: lane.packetId,
      laneId: lane.id,
      status: lane.status,
      runtime: lane.runtime,
      sessionKey: lane.sessionKey,
    }] : [],
    approvals: approvals.map((approval) => ({
      id: approval.id,
      status: approval.status,
      risk: approval.risk,
      title: approval.title,
      updatedAt: approval.updatedAt,
    })),
    laneStates: [{
      laneId: lane.id,
      status: lane.status,
      outcome: lane.outcome ?? null,
      updatedAt: lane.updatedAt,
    }],
    events: events.map((event) => ({
      verb: event.verb,
      actor: event.actor,
      timestamp: event.timestamp,
    })),
    eventsTruncated,
    retryBudget: {
      executionFailuresConsumed: null,
      limit: null,
      note: 'The lane ledger does not expose one canonical execution-failure budget yet.',
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

  const narrative = narrativeFromRecord(record, input.excludeMessageId);
  const messages = narrative.messages;
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  if (assistantMessages.length === 0) {
    throw new HandoffPacketError(
      'The source thread has no completed assistant turn to hand off.',
      'handoff_thread_empty',
      409,
    );
  }

  const lane = resolveHandoffLane(input.laneId?.trim() || undefined, repoPath);
  const worktreePath = lane?.worktreePath ?? repoPath;
  const workspace = await buildWorkspace(lane?.repoPath ?? repoPath, worktreePath);
  const governance = buildGovernance(lane);
  const verifiedClaims = cleanTextList(input.verifiedClaims);
  const unverifiedClaims = cleanTextList(input.unverifiedClaims);
  const attributedAssistantTurns = assistantMessages.filter((message) => message.backend).length;

  return {
    schema: HANDOFF_PACKET_SCHEMA,
    handoffId: input.handoffId?.trim() || `handoff-${randomUUID()}`,
    createdAt: input.createdAt?.trim() || new Date().toISOString(),
    threadId,
    from: sourceFromMessages(messages, record),
    to,
    carries: {
      narrative: 'full',
      intent: normalizedIntent ? 'full' : 'omitted',
      workspace: workspace ? 'full' : 'omitted',
      governance: governance ? 'summary' : 'omitted',
      provenance: 'summary',
    },
    narrative: {
      messages,
      seams: narrative.seams,
      tokenEstimate: estimateNarrativeTokens(messages),
      compactedBy: null,
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
