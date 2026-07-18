import { appendEvent, findLaneByPacket, getLane, setLaneStatus, updateLane } from './registry';
import type { AgentReportReason, Lane, LaneEvent, LaneEventActor } from './types';

export const AGENT_REPORT_REASONS: readonly AgentReportReason[] = [
  'needs_clarification',
  'missing_context',
  'out_of_scope',
  'dependency_blocked',
  'context_full',
  'nondeterministic_test',
  'external_api_down',
  'unknown',
];

export const PACKET_AGENT_REPORT_EVENTS = [
  'progress',
  'blocked',
  'question',
  'huddle',
] as const;

export type PacketAgentReportEvent = (typeof PACKET_AGENT_REPORT_EVENTS)[number];

// `huddle` (#1282 / Huddle mode) is a worker's pre-implementation alignment
// turn: it posts its plan + any pushback, which flips the lane to
// `awaiting_orchestrator` exactly like `blocked`/`question` so the orchestrator
// reviews and steers (warm `codex exec resume`) before the worker edits.
const BLOCKING_AGENT_REPORT_EVENTS = new Set(['blocked', 'question', 'huddle']);

export interface AgentReportInput {
  laneId?: string;
  packetId?: string;
  actor?: LaneEventActor;
  event: string;
  reason?: AgentReportReason;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentReportResult {
  lane: Lane;
  event: LaneEvent;
  statusChanged: boolean;
}

export function isAgentReportReason(value: unknown): value is AgentReportReason {
  return typeof value === 'string' && AGENT_REPORT_REASONS.includes(value as AgentReportReason);
}

export function isPacketAgentReportEvent(value: unknown): value is PacketAgentReportEvent {
  return typeof value === 'string'
    && PACKET_AGENT_REPORT_EVENTS.includes(value as PacketAgentReportEvent);
}

export function normalizeAgentReportEvent(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeAgentReportMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeAgentReportMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function reportAgentEvent(input: AgentReportInput): AgentReportResult | null {
  const actor = input.actor ?? 'system';
  const lane = input.laneId
    ? getLane(input.laneId)
    : input.packetId
      ? findLaneByPacket(input.packetId)
      : null;

  if (!lane) {
    return null;
  }

  const payload: Record<string, unknown> = {
    packetId: lane.packetId ?? input.packetId ?? null,
    event: input.event,
  };
  if (input.reason) payload.reason = input.reason;
  if (input.message) payload.message = input.message;
  if (input.metadata) payload.metadata = input.metadata;

  const event = appendEvent(lane.id, 'agent_report', actor, payload);
  if (!BLOCKING_AGENT_REPORT_EVENTS.has(input.event)) {
    const updatedLane = updateLane(
      lane.id,
      { lastEventAt: event.timestamp, lastEventLabel: input.event },
      actor,
    ) ?? lane;
    return { lane: updatedLane, event, statusChanged: false };
  }

  const updatedLane = setLaneStatus(
    lane.id,
    'awaiting_orchestrator',
    actor,
    input.reason ?? input.event,
  ) ?? lane;

  return {
    lane: updatedLane,
    event,
    statusChanged: updatedLane.status !== lane.status,
  };
}
