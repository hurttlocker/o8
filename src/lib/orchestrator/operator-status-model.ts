import type { ApprovalRecord } from '@/lib/approvals/types';
import type { AgentStatus, AgentSummary } from '@/lib/fleet/types';
import { isLaneTerminal } from '@/lib/lane/terminal-states';
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
  if (typeof agent.lastActivityAt === 'number' && Number.isFinite(agent.lastActivityAt)) {
    return new Date(agent.lastActivityAt).toISOString();
  }
  for (const value of [agent.lastEventAt, lane?.lastEventAt, lane?.updatedAt]) {
    if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  }
  return agent.statusEvidence?.observedAt
    || agent.lastEventAt
    || lane?.lastEventAt
    || lane?.updatedAt
    || '';
}

function approvalMatchesAgent(approval: ApprovalRecord, agent: AgentSummary, lane: Lane | undefined): boolean {
  if (approval.sessionKey === agent.sessionKey) return true;
  return Boolean(lane && approvalMatchesLane(approval, lane));
}

function approvalMatchesLane(approval: ApprovalRecord, lane: Lane): boolean {
  if (lane.sessionKey && approval.sessionKey === lane.sessionKey) return true;
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

const LANE_ONLY_OPERATOR_STATUSES = new Set<Lane['status']>([
  'launching',
  'running',
  'awaiting_input',
  'awaiting_orchestrator',
  'awaiting_human',
  'recovering',
  'reviewing',
  'merging',
  'failed',
]);

// A `failed` lane never transitions on its own — only an operator redispatch
// or archive moves it forward — so keeping it in LANE_ONLY_OPERATOR_STATUSES
// without a bound means `o8_status` reports an agent for work that ended
// hours or days ago (#2047). Bound how long a lane-terminal status (today
// just `failed`; `isLaneTerminal` also covers `completed`/`archived` should
// either land in the set later) keeps synthesizing an agent row: 30 minutes
// is long enough for the operator to notice a fresh failure in the status
// feed during the same session, short enough that a stale failure doesn't
// linger indefinitely. A lane with no session key carries no live-session
// evidence at all, so it drops immediately regardless of age.
const TERMINAL_LANE_ONLY_STALE_WINDOW_MS = 30 * 60_000;

function isStaleTerminalLaneOnlyAgent(lane: Lane, nowMs: number): boolean {
  if (!isLaneTerminal(lane.status)) return false;
  if (!lane.sessionKey) return true;
  const observedAt = lane.lastEventAt || lane.updatedAt;
  const parsed = observedAt ? Date.parse(observedAt) : NaN;
  if (!Number.isFinite(parsed)) return true;
  return nowMs - parsed > TERMINAL_LANE_ONLY_STALE_WINDOW_MS;
}

function safeResolveLaneOnlyStatusEvidence(
  lane: Lane,
  context: OperatorStatusEvidenceContext,
): TerminalStatusEvidence {
  try {
    return resolveTerminalStatusEvidence({
      lane,
      laneEvents: context.laneEventsByLaneId?.get(lane.id) ?? [],
      approvals: (context.approvals ?? []).filter((approval) => (
        approval.status === 'pending' && approvalMatchesLane(approval, lane)
      )),
      reviewQueue: (context.reviewQueue ?? []).filter((review) => review.laneId === lane.id),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[terminal-status] Failed to resolve lane-only status for ${lane.id}: ${message}`);
    return unknownTerminalStatusEvidence({
      sessionId: lane.sessionKey || lane.id,
      runtime: lane.runtime,
      observedAt: lane.lastEventAt ?? lane.updatedAt,
      summary: 'Terminal status evidence could not be resolved for this lane.',
      fallbackReason: `Status resolution failed for this lane: ${message}`,
    });
  }
}

function operatorStatusAgentFromLane(
  lane: Lane & { sessionKey: string },
  context: OperatorStatusEvidenceContext,
): OperatorStatusAgent {
  const statusEvidence = safeResolveLaneOnlyStatusEvidence(lane, context);
  return {
    name: lane.label || lane.sessionKey,
    repo: repoFromWorkspace(lane.worktreePath || lane.repoPath),
    runtime: lane.runtime,
    model: lane.model ?? null,
    status: operatorStatusFromTerminalState(statusEvidence.state, lane.status),
    branch: lane.branch,
    elapsed: lane.lastEventAt || lane.updatedAt,
    sessionKey: lane.sessionKey,
    task: lane.lastEventLabel,
    authority: statusEvidence.authority,
    summary: statusEvidence.summary,
    observedAt: statusEvidence.observedAt,
    statusEvidence,
  };
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

  const inventoryAgents = filtered.map((session) => {
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

  // Runtime discovery is observational and can briefly return no session while
  // a warm worker is still advancing. The lane registry is the durable
  // lifecycle record, so an active lane must remain visible even during that
  // discovery gap. Only synthesize a lane-backed row when inventory did not
  // already provide the same session, and never resurrect idle/archived lanes.
  const representedSessionKeys = new Set(inventoryAgents.map((agent) => agent.sessionKey));
  const nowMs = Date.now();
  const laneOnlyAgents = [...laneBySession.values()]
    .filter((lane): lane is Lane & { sessionKey: string } => Boolean(
      lane.sessionKey
      && LANE_ONLY_OPERATOR_STATUSES.has(lane.status)
      && !representedSessionKeys.has(lane.sessionKey)
      && (!sessionKeyFilter || lane.sessionKey === sessionKeyFilter)
      && !isStaleTerminalLaneOnlyAgent(lane, nowMs),
    ))
    .map((lane) => operatorStatusAgentFromLane(lane, context));

  return [...inventoryAgents, ...laneOnlyAgents];
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
