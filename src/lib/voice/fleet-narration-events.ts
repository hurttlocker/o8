import { agentDisplayLabel } from '@/lib/orchestrator/display';
import type { workerEvents } from '@/lib/db/schema';
import type { AgentStatus, AgentSummary, EventItem } from '@/lib/fleet/types';
import type { Lane, LaneEvent, LaneStatus } from '@/lib/lane/types';
import type {
  OrchestratorPacket,
  OrchestratorPacketStatus,
  OrchestratorRuntime,
} from '@/lib/orchestrator/types';
import type { TurnSummary } from '@/components/desktop/thoughts/chat-panel/TurnSummaryCard';

type WorkerEventRow = typeof workerEvents.$inferSelect;

export type FleetNarrationKind =
  | 'progress'
  | 'review-ready'
  | 'approval-needed'
  | 'escalation'
  | 'conflict'
  | 'failure'
  | 'merged'
  | 'blocked'
  | 'question'
  | 'retry'
  | 'launched'
  | 'completed'
  | 'interrupted'
  | 'changed-files'
  | 'other';

export interface FleetNarrationAgentIdentity {
  id?: string | null;
  name?: string | null;
  title?: string | null;
  runtime?: OrchestratorRuntime | string | null;
  sessionKey?: string | null;
}

type NarrationLane = Pick<
  Lane,
  'id' | 'label' | 'packetId' | 'runtime' | 'sessionKey' | 'status' | 'lastEventLabel' | 'outcome'
>;

type NarrationPacket = Pick<
  OrchestratorPacket,
  | 'id'
  | 'referenceLabel'
  | 'title'
  | 'status'
  | 'blockedReason'
  | 'lastEventLabel'
  | 'lastEventAt'
  | 'runtime'
  | 'lane'
>;

export type FleetNarrationSourceEvent =
  | {
      source: 'lane-event';
      event: LaneEvent;
      lane?: NarrationLane | null;
      packet?: NarrationPacket | null;
      agent?: FleetNarrationAgentIdentity | null;
    }
  | {
      source: 'worker-event';
      row: WorkerEventRow;
      lane?: NarrationLane | null;
      packet?: NarrationPacket | null;
      agent?: FleetNarrationAgentIdentity | null;
    }
  | {
      source: 'packet-state';
      packet: NarrationPacket;
      previousStatus?: OrchestratorPacketStatus | null;
      timestamp: string;
      agent?: FleetNarrationAgentIdentity | null;
    }
  | {
      source: 'agent-lifecycle';
      agent: Pick<
        AgentSummary,
        'id' | 'name' | 'runtime' | 'sessionKey' | 'status' | 'currentTask' | 'orchestrationPacket'
      >;
      previousStatus?: AgentStatus | null;
      timestamp: string;
    }
  | {
      source: 'fleet-event';
      event: EventItem;
      agent?: FleetNarrationAgentIdentity | null;
    }
  | {
      source: 'turn-summary';
      summary: TurnSummary;
      timestamp: string;
      agent?: FleetNarrationAgentIdentity | null;
      laneId?: string | null;
      packetId?: string | null;
    };

export interface FleetNarrationRawRef {
  source: FleetNarrationSourceEvent['source'];
  id: string;
  raw: FleetNarrationSourceEvent;
}

export interface FleetNarrationEvent {
  id: string;
  occurredAt: string;
  agentId: string | null;
  laneId: string | null;
  packetId: string | null;
  agentLabel: string;
  kind: FleetNarrationKind;
  summary: string;
  /** Identity whose state transitions are deduped. */
  transitionKey: string;
  /** Semantic state used to suppress repeated same-state updates. */
  transitionState: string;
  /** False when a snapshot explicitly says the status did not change. */
  isTransition: boolean;
  rawRef: FleetNarrationRawRef;
}

interface ClassifiedEvent {
  kind: FleetNarrationKind;
  summary: string;
  transitionState?: string;
}

const SESSION_KEY_PATTERN = /\b(?:codex-owned|gemini-owned|opencode-owned|cursor-owned|grok-owned|claude-code):[^\s,;]+/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function payloadString(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function oneLine(value: string, agentLabel: string): string {
  const line = value
    .replace(SESSION_KEY_PATTERN, agentLabel)
    .replace(/\s+/g, ' ')
    .trim();
  if (line.length <= 180) return line;
  return `${line.slice(0, 177).trimEnd()}…`;
}

function identityForSource(source: FleetNarrationSourceEvent): {
  agent: FleetNarrationAgentIdentity | null;
  lane: NarrationLane | null;
  packet: NarrationPacket | null;
} {
  switch (source.source) {
    case 'lane-event':
    case 'worker-event':
      return {
        agent: source.agent ?? null,
        lane: source.lane ?? null,
        packet: source.packet ?? null,
      };
    case 'packet-state':
      return {
        agent: source.agent ?? null,
        lane: null,
        packet: source.packet,
      };
    case 'agent-lifecycle':
      return {
        agent: source.agent,
        lane: null,
        packet: null,
      };
    case 'fleet-event':
      return {
        agent: source.agent ?? null,
        lane: null,
        packet: null,
      };
    case 'turn-summary':
      return {
        agent: source.agent ?? null,
        lane: null,
        packet: null,
      };
  }
}

function humanAgentLabel(source: FleetNarrationSourceEvent): string {
  const { agent, lane, packet } = identityForSource(source);
  return agentDisplayLabel({
    name: agent?.name ?? lane?.label ?? packet?.title,
    title: agent?.title ?? packet?.referenceLabel,
    sessionKey: agent?.sessionKey ?? lane?.sessionKey ?? packet?.lane?.sessionKey,
    runtime: agent?.runtime ?? lane?.runtime ?? packet?.runtime,
  });
}

function classifyStatus(
  status: LaneStatus | OrchestratorPacketStatus,
  label: string | null,
): ClassifiedEvent {
  const signal = `${status} ${label ?? ''}`.toLowerCase();
  if (signal.includes('conflict')) {
    return { kind: 'conflict', summary: 'Merge conflict needs attention.', transitionState: 'conflict' };
  }
  if (signal.includes('fail') || signal.includes('error')) {
    return { kind: 'failure', summary: humanize(label ?? 'The agent failed.'), transitionState: 'failure' };
  }
  if (signal.includes('typecheck_auto_retry')) {
    return { kind: 'retry', summary: 'Typecheck failed; the packet is retrying.', transitionState: 'typecheck-retry' };
  }
  switch (status) {
    case 'awaiting_review':
    case 'reviewing':
      return {
        kind: 'review-ready',
        summary: 'Work is ready and awaiting review.',
        transitionState: 'review-ready',
      };
    case 'blocked':
      return { kind: 'blocked', summary: humanize(label ?? 'Work is blocked.'), transitionState: 'blocked' };
    case 'awaiting_input':
    case 'awaiting_orchestrator':
    case 'awaiting_human':
    case 'recovering':
      return {
        kind: 'escalation',
        summary: humanize(label ?? 'The agent needs a decision.'),
        transitionState: status,
      };
    case 'failed':
      return { kind: 'failure', summary: humanize(label ?? 'The agent failed.'), transitionState: 'failure' };
    case 'released':
      return { kind: 'merged', summary: 'Work merged and was released.', transitionState: 'merged' };
    case 'completed':
      return {
        kind: signal.includes('merge') ? 'merged' : 'completed',
        summary: signal.includes('merge') ? 'Work merged.' : 'Work completed.',
        transitionState: signal.includes('merge') ? 'merged' : 'completed',
      };
    case 'launching':
    case 'queued':
      return { kind: 'launched', summary: 'The packet is launching.', transitionState: 'launching' };
    case 'paused':
      return { kind: 'interrupted', summary: 'The agent is paused.', transitionState: 'paused' };
    case 'running':
    case 'merging':
      return {
        kind: 'progress',
        summary: humanize(label ?? (status === 'merging' ? 'Merge is in progress.' : 'Work is in progress.')),
        transitionState: status,
      };
    case 'draft':
    case 'idle':
    case 'archived':
      return { kind: 'other', summary: humanize(label ?? status), transitionState: status };
  }
}

function classifyLaneEvent(event: LaneEvent, lane?: NarrationLane | null): ClassifiedEvent {
  const payload = event.payload;
  const label = payloadString(payload, 'message', 'reason', 'note', 'blockedReason')
    ?? lane?.lastEventLabel
    ?? event.verb;
  const signal = `${event.verb} ${label}`.toLowerCase();

  if (event.verb === 'agent_report') {
    const reportEvent = payloadString(payload, 'event') ?? 'progress';
    if (reportEvent === 'blocked') {
      return { kind: 'blocked', summary: label, transitionState: 'blocked' };
    }
    if (reportEvent === 'question') {
      return { kind: 'question', summary: label, transitionState: 'question' };
    }
    if (reportEvent === 'huddle') {
      return { kind: 'escalation', summary: label, transitionState: 'huddle' };
    }
    if (reportEvent === 'progress') {
      return { kind: 'progress', summary: label, transitionState: 'progress' };
    }
    return { kind: 'other', summary: label, transitionState: reportEvent };
  }
  if (event.verb === 'typecheck_auto_retry') {
    return { kind: 'retry', summary: label, transitionState: 'typecheck-retry' };
  }
  if (event.verb === 'typecheck_escalation') {
    return { kind: 'escalation', summary: label, transitionState: 'typecheck-escalation' };
  }
  if (signal.includes('conflict')) {
    return { kind: 'conflict', summary: label, transitionState: 'conflict' };
  }
  if (signal.includes('fail') || signal.includes('error') || event.verb === 'session_lost') {
    return { kind: 'failure', summary: label, transitionState: 'failure' };
  }
  if (signal.includes('block') || signal.includes('awaiting_human')) {
    return { kind: 'blocked', summary: label, transitionState: 'blocked' };
  }
  if (signal.includes('merged') || event.verb === 'merge_cleanup') {
    return { kind: 'merged', summary: label, transitionState: 'merged' };
  }
  if (signal.includes('review') || lane?.status === 'reviewing') {
    return { kind: 'review-ready', summary: label, transitionState: 'review-ready' };
  }
  if (event.verb === 'status_change') {
    const to = payloadString(payload, 'status', 'to');
    if (to) return classifyStatus(to as LaneStatus, label);
  }
  if (lane) return classifyStatus(lane.status, label);
  return { kind: 'other', summary: label, transitionState: event.verb };
}

function parseWorkerPayload(row: WorkerEventRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.payloadJson) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function classifyWorkerEvent(row: WorkerEventRow): ClassifiedEvent {
  const payload = parseWorkerPayload(row);
  switch (row.eventType) {
    case 'progress':
      return {
        kind: 'progress',
        summary: payloadString(payload, 'text', 'message') ?? 'Remote work is in progress.',
        transitionState: 'progress',
      };
    case 'branch_pushed':
      return {
        kind: 'changed-files',
        summary: 'The remote worker pushed its branch.',
        transitionState: 'branch-pushed',
      };
    case 'completed':
      return {
        kind: 'completed',
        summary: payloadString(payload, 'result') ?? 'The remote worker completed.',
        transitionState: 'completed',
      };
    case 'errored':
      return {
        kind: 'failure',
        summary: payloadString(payload, 'message') ?? 'The remote worker failed.',
        transitionState: 'failure',
      };
    case 'launch':
      return { kind: 'launched', summary: 'The remote worker launched.', transitionState: 'launched' };
    case 'interrupt':
      return {
        kind: 'interrupted',
        summary: 'The remote worker was interrupted.',
        transitionState: 'interrupted',
      };
    default:
      return {
        kind: 'other',
        summary: `Remote worker event: ${humanize(row.eventType)}.`,
        transitionState: row.eventType,
      };
  }
}

function classifyAgentLifecycle(
  agent: Extract<FleetNarrationSourceEvent, { source: 'agent-lifecycle' }>['agent'],
): ClassifiedEvent {
  switch (agent.status) {
    case 'reviewing':
      return {
        kind: 'review-ready',
        summary: 'Work is ready and awaiting review.',
        transitionState: 'review-ready',
      };
    case 'blocked':
      return {
        kind: 'blocked',
        summary: agent.currentTask || 'Work is blocked.',
        transitionState: 'blocked',
      };
    case 'failed':
      return {
        kind: 'failure',
        summary: agent.currentTask || 'The agent failed.',
        transitionState: 'failure',
      };
    case 'huddling':
      return {
        kind: 'escalation',
        summary: agent.currentTask || 'The agent is awaiting alignment.',
        transitionState: 'huddle',
      };
    case 'completed':
      return { kind: 'completed', summary: 'The agent completed its turn.', transitionState: 'completed' };
    case 'running':
      return {
        kind: 'progress',
        summary: agent.currentTask || 'Work is in progress.',
        transitionState: 'running',
      };
    case 'waiting':
    case 'idle':
      return {
        kind: 'other',
        summary: agent.currentTask || `The agent is ${agent.status}.`,
        transitionState: agent.status,
      };
  }
}

function classifyFleetEvent(event: EventItem): ClassifiedEvent {
  const signal = `${event.subLabel ?? ''} ${event.title} ${event.detail}`.toLowerCase();
  if (signal.includes('conflict')) {
    return { kind: 'conflict', summary: event.detail, transitionState: 'conflict' };
  }
  if (event.subLabel === 'blocked' || signal.includes(' blocked')) {
    return { kind: 'blocked', summary: event.detail, transitionState: 'blocked' };
  }
  if (event.subLabel === 'question' || event.subLabel === 'huddle') {
    return { kind: 'escalation', summary: event.detail, transitionState: event.subLabel };
  }
  if (signal.includes('review') || signal.includes('approval')) {
    return { kind: 'review-ready', summary: event.detail, transitionState: 'review-ready' };
  }
  if (event.severity === 'critical' || signal.includes('fail') || signal.includes('error')) {
    return { kind: 'failure', summary: event.detail, transitionState: 'failure' };
  }
  if (signal.includes('merged') || signal.includes('released')) {
    return { kind: 'merged', summary: event.detail, transitionState: 'merged' };
  }
  return {
    kind: event.severity === 'success' ? 'completed' : 'progress',
    summary: event.detail || event.title,
    transitionState: event.subLabel ?? event.severity,
  };
}

function classifyTurnSummary(summary: TurnSummary): ClassifiedEvent {
  if (summary.filesEditedCount > 0) {
    return {
      kind: 'changed-files',
      summary: `Edited ${summary.filesEditedCount} ${summary.filesEditedCount === 1 ? 'file' : 'files'} during the turn.`,
      transitionState: 'changed-files',
    };
  }
  return {
    kind: 'completed',
    summary: `Turn completed after ${Math.max(1, Math.round(summary.elapsedMs / 1_000))} seconds.`,
    transitionState: 'turn-completed',
  };
}

function classifySource(source: FleetNarrationSourceEvent): ClassifiedEvent {
  switch (source.source) {
    case 'lane-event':
      return classifyLaneEvent(source.event, source.lane);
    case 'worker-event':
      return classifyWorkerEvent(source.row);
    case 'packet-state':
      return classifyStatus(
        source.packet.status,
        source.packet.blockedReason ?? source.packet.lastEventLabel ?? null,
      );
    case 'agent-lifecycle':
      return classifyAgentLifecycle(source.agent);
    case 'fleet-event':
      return classifyFleetEvent(source.event);
    case 'turn-summary':
      return classifyTurnSummary(source.summary);
  }
}

function sourceIsTransition(source: FleetNarrationSourceEvent): boolean {
  if (source.source === 'packet-state') {
    return source.previousStatus === undefined
      || source.previousStatus === null
      || source.previousStatus !== source.packet.status;
  }
  if (source.source === 'agent-lifecycle') {
    return source.previousStatus === undefined
      || source.previousStatus === null
      || source.previousStatus !== source.agent.status;
  }
  return true;
}

function sourceFacts(source: FleetNarrationSourceEvent) {
  switch (source.source) {
    case 'lane-event':
      return {
        id: source.event.id,
        occurredAt: source.event.timestamp,
        agentId: source.agent?.id ?? source.lane?.id ?? null,
        laneId: source.event.laneId,
        packetId: source.packet?.id ?? source.lane?.packetId ?? null,
      };
    case 'worker-event':
      return {
        id: `worker-${source.row.workerRunId}-${source.row.id}`,
        occurredAt: source.row.createdAt,
        agentId: source.agent?.id ?? source.lane?.id ?? null,
        laneId: source.lane?.id ?? null,
        packetId: source.packet?.id ?? source.lane?.packetId ?? null,
      };
    case 'packet-state':
      return {
        id: `packet-${source.packet.id}-${source.timestamp}-${source.packet.status}`,
        occurredAt: source.timestamp,
        agentId: source.agent?.id ?? source.packet.lane?.laneId ?? source.packet.id,
        laneId: source.packet.lane?.laneId ?? null,
        packetId: source.packet.id,
      };
    case 'agent-lifecycle':
      return {
        id: `agent-${source.agent.id}-${source.timestamp}-${source.agent.status}`,
        occurredAt: source.timestamp,
        agentId: source.agent.id,
        laneId: null,
        packetId: source.agent.orchestrationPacket?.packetId ?? null,
      };
    case 'fleet-event':
      return {
        id: source.event.id,
        occurredAt: source.event.timestamp,
        agentId: source.event.agentId ?? source.agent?.id ?? null,
        laneId: null,
        packetId: null,
      };
    case 'turn-summary':
      return {
        id: `turn-${source.summary.assistantMessageId}`,
        occurredAt: source.timestamp,
        agentId: source.agent?.id ?? null,
        laneId: source.laneId ?? null,
        packetId: source.packetId ?? null,
      };
  }
}

export function normalizeFleetNarrationEvent(
  source: FleetNarrationSourceEvent,
): FleetNarrationEvent {
  const facts = sourceFacts(source);
  const agentLabel = humanAgentLabel(source);
  const classified = classifySource(source);
  const identity = facts.packetId ?? facts.laneId ?? facts.agentId ?? facts.id;
  return {
    ...facts,
    agentLabel,
    kind: classified.kind,
    summary: oneLine(classified.summary, agentLabel),
    transitionKey: identity,
    transitionState: classified.transitionState ?? classified.kind,
    isTransition: sourceIsTransition(source),
    rawRef: {
      source: source.source,
      id: facts.id,
      raw: source,
    },
  };
}

export function normalizeFleetNarrationEvents(
  sources: readonly FleetNarrationSourceEvent[],
): FleetNarrationEvent[] {
  return sources.map(normalizeFleetNarrationEvent);
}
