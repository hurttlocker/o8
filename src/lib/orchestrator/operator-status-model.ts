import type { ApprovalRecord } from '@/lib/approvals/types';
import type { AgentStatus, AgentSummary } from '@/lib/fleet/types';
import type { Lane, LaneEvent } from '@/lib/lane/types';
import type { RuntimeId, RuntimeSessionStatus } from '@/lib/runtimes/types';
import {
  agentStatusFromTerminalState,
  resolveTerminalStatusEvidence,
  unknownTerminalStatusEvidence,
  type TerminalReviewQueueEvidence,
  type TerminalStatusEvidence,
  type TerminalStatusState,
} from '@/lib/terminal-status/resolve';

export interface OperatorStatusAgent {
  name: string;
  repo: string;
  runtime: RuntimeId;
  model: string | null;
  status: string;
  branch: string;
  elapsed: string;
  sessionKey: string;
  task: string | null;
  authority: TerminalStatusEvidence['authority'];
  summary: string;
  observedAt: string;
  statusEvidence: TerminalStatusEvidence;
}

export interface OperatorStatusEvidenceContext {
  laneEventsByLaneId?: ReadonlyMap<string, LaneEvent[]>;
  approvals?: ApprovalRecord[];
  reviewQueue?: TerminalReviewQueueEvidence[];
}

function repoFromWorkspace(workspace: string | undefined) {
  return workspace?.split('/').filter(Boolean).pop() || 'unknown';
}

function runtimeStatusFromAgent(status: AgentStatus): RuntimeSessionStatus {
  switch (status) {
    case 'running':
    case 'huddling':
      return 'running';
    case 'blocked':
    case 'waiting':
      return 'waiting';
    case 'reviewing':
      return 'reviewing';
    case 'failed':
      return 'failed';
    case 'completed':
      return 'completed';
    case 'idle':
      return 'idle';
  }
}

function observedAtForAgent(agent: AgentSummary, lane: Lane | undefined): string {
  if (agent.statusEvidence?.observedAt) return agent.statusEvidence.observedAt;
  if (typeof agent.lastActivityAt === 'number' && Number.isFinite(agent.lastActivityAt)) {
    return new Date(agent.lastActivityAt).toISOString();
  }
  return agent.lastEventAt || lane?.lastEventAt || lane?.updatedAt || '';
}

function approvalMatchesAgent(approval: ApprovalRecord, agent: AgentSummary, lane: Lane | undefined): boolean {
  if (approval.sessionKey === agent.sessionKey) return true;
  if (!lane) return false;
  if (approval.continuation?.kind === 'lane' && approval.continuation.laneId === lane.id) return true;
  return approval.metadata?.laneId === lane.id || approval.metadata?.LaneId === lane.id;
}

function mergeEvidence(
  resolved: TerminalStatusEvidence,
  previous: TerminalStatusEvidence | undefined,
): TerminalStatusEvidence {
  if (!previous) return resolved;
  const seen = new Set<string>();
  const evidence = [...previous.evidence, ...resolved.evidence].filter((item) => {
    const key = `${item.source}\u0000${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (resolved.authority === 'runtime-event' && previous.authority === 'runtime-event') {
    return { ...resolved, observedAt: previous.observedAt, summary: previous.summary, evidence };
  }
  return { ...resolved, evidence };
}

export function resolveAgentSummaryStatusEvidence(
  agent: AgentSummary,
  lane: Lane | undefined,
  context: OperatorStatusEvidenceContext = {},
): TerminalStatusEvidence {
  const previous = agent.statusEvidence;
  const observedAt = observedAtForAgent(agent, lane);
  const laneEvents = lane ? context.laneEventsByLaneId?.get(lane.id) ?? [] : [];
  const approvals = (context.approvals ?? []).filter((approval) => (
    approval.status === 'pending' && approvalMatchesAgent(approval, agent, lane)
  ));
  const reviewQueue = lane
    ? (context.reviewQueue ?? []).filter((review) => review.laneId === lane.id)
    : [];
  const rawLifecycle = previous?.authority === 'raw-terminal'
    ? {
        sessionId: agent.sessionKey,
        runtime: agent.runtime as RuntimeId,
        state: previous.state,
        observedAt: previous.observedAt,
      }
    : undefined;
  const runtimeSession = previous?.authority === 'raw-terminal'
    || previous?.authority === 'lane-state'
    || previous?.authority === 'known-screen-adapter'
    ? undefined
    : {
        sessionKey: agent.sessionKey,
        runtimeId: agent.runtime as RuntimeId,
        status: runtimeStatusFromAgent(agent.status),
        observedAt,
        lifecycle: agent.runtimeSurface?.lifecycle,
      };
  const evidence = resolveTerminalStatusEvidence({
    runtimeSession,
    lane,
    laneEvents,
    approvals,
    reviewQueue,
    rawLifecycle,
  });
  return mergeEvidence(evidence, previous);
}

function safeResolveAgentSummaryStatusEvidence(
  agent: AgentSummary,
  lane: Lane | undefined,
  context: OperatorStatusEvidenceContext,
): TerminalStatusEvidence {
  try {
    return resolveAgentSummaryStatusEvidence(agent, lane, context);
  } catch (error) {
    const sessionId = agent.sessionKey || agent.id || 'unknown-session';
    const runtime = agent.runtime || 'unknown';
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[terminal-status] Failed to resolve status for ${sessionId}: ${message}`);
    return unknownTerminalStatusEvidence({
      sessionId,
      runtime,
      observedAt: agent.lastActivityAt ?? agent.lastEventAt,
      summary: 'Terminal status evidence could not be resolved for this session.',
      fallbackReason: `Status resolution failed for this session: ${message}`,
    });
  }
}

export function resolveAgentSummaryStatuses(
  sessions: AgentSummary[],
  lanes: Lane[],
  context: OperatorStatusEvidenceContext = {},
): AgentSummary[] {
  const laneBySession = new Map(
    lanes
      .filter((lane) => lane.sessionKey)
      .map((lane) => [lane.sessionKey as string, lane]),
  );
  return sessions.map((agent) => {
    const statusEvidence = safeResolveAgentSummaryStatusEvidence(
      agent,
      laneBySession.get(agent.sessionKey),
      context,
    );
    return {
      ...agent,
      status: agentStatusFromTerminalState(statusEvidence.state, agent.status),
      statusEvidence,
    };
  });
}

function operatorStatusFromTerminalState(state: TerminalStatusState, fallback: string): string {
  if (state === 'review-ready') return 'awaiting_review';
  if (state === 'working') return 'running';
  if (state === 'complete') return 'completed';
  return state === 'unknown' ? fallback : state;
}

function canonicalAgentStatus(
  agent: AgentSummary,
  statusEvidence: TerminalStatusEvidence,
): string {
  // resolveTerminalStatusEvidence is the single source for status precedence.
  return operatorStatusFromTerminalState(statusEvidence.state, agent.status || 'idle');
}

export function buildOperatorStatusAgents(
  sessions: AgentSummary[],
  lanes: Lane[],
  sessionKeyFilter?: string,
  context: OperatorStatusEvidenceContext = {},
): OperatorStatusAgent[] {
  const laneBySession = new Map(
    lanes
      .filter((lane) => lane.sessionKey)
      .map((lane) => [lane.sessionKey as string, lane]),
  );

  const filtered = sessionKeyFilter
    ? sessions.filter((session) => session.sessionKey === sessionKeyFilter)
    : sessions;

  return filtered.map((session) => {
    const lane = laneBySession.get(session.sessionKey);
    const statusEvidence = safeResolveAgentSummaryStatusEvidence(session, lane, context);
    return {
      name: session.name || session.sessionKey,
      repo: repoFromWorkspace(lane?.repoPath || session.workspace),
      runtime: session.runtime || 'unknown',
      model: lane?.model ?? session.model ?? null,
      status: canonicalAgentStatus(session, statusEvidence),
      branch: lane?.branch || session.branch || 'main',
      elapsed: session.lastEventAt || '',
      sessionKey: session.sessionKey,
      task: session.currentTask || lane?.lastEventLabel || null,
      authority: statusEvidence.authority,
      summary: statusEvidence.summary,
      observedAt: statusEvidence.observedAt,
      statusEvidence,
    };
  });
}

const ACTIVE_STATUSES = new Set(['launching', 'running', 'working', 'recovering']);
const REVIEW_STATUSES = new Set(['awaiting_review']);
const ATTENTION_STATUSES = new Set(['blocked', 'failed']);

export function summarizeOperatorStatus(input: {
  agents: OperatorStatusAgent[];
  approvalCount: number;
  recentActivity?: Array<Record<string, unknown>>;
}): string {
  const runningCount = input.agents.filter((agent) => ACTIVE_STATUSES.has(agent.status)).length;
  const reviewCount = input.agents.filter((agent) => REVIEW_STATUSES.has(agent.status)).length;
  const attentionCount = input.agents.filter((agent) => ATTENTION_STATUSES.has(agent.status)).length;
  const latestEvent = input.recentActivity?.[0];
  const lastDesc = latestEvent
    ? `Last: ${(latestEvent.action as string) || ''}${latestEvent.target ? ` ${latestEvent.target}` : ''}`.trim()
    : input.agents[0]
      ? `Last: ${input.agents[0].name} ${input.agents[0].status}`
      : 'No recent activity';

  const pieces = [
    `${runningCount} agent${runningCount === 1 ? '' : 's'} running`,
    `${input.approvalCount} approval${input.approvalCount === 1 ? '' : 's'} pending`,
  ];
  if (reviewCount > 0) pieces.push(`${reviewCount} awaiting review`);
  if (attentionCount > 0) pieces.push(`${attentionCount} needs attention`);
  pieces.push(lastDesc);
  return `${pieces.join('. ')}.`;
}
