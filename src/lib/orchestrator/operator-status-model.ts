import { packetStatusFromLaneStatus } from '@/lib/orchestrator/packet-state';
import type { AgentSummary } from '@/lib/fleet/types';
import type { Lane } from '@/lib/lane/types';

export interface OperatorStatusAgent {
  name: string;
  repo: string;
  runtime: string;
  model: string | null;
  status: string;
  branch: string;
  elapsed: string;
  sessionKey: string;
  task: string | null;
}

function repoFromWorkspace(workspace: string | undefined) {
  return workspace?.split('/').filter(Boolean).pop() || 'unknown';
}

function canonicalAgentStatus(agent: AgentSummary, lane: Lane | undefined): string {
  const laneStatus = packetStatusFromLaneStatus(lane?.status);
  if (!laneStatus) return agent.status || 'idle';

  // A live lane is the canonical packet truth. This masks transient runtime
  // discovery failures while the owned session is still progressing.
  return laneStatus;
}

export function buildOperatorStatusAgents(
  sessions: AgentSummary[],
  lanes: Lane[],
  sessionKeyFilter?: string,
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
    return {
      name: session.name || session.sessionKey,
      repo: repoFromWorkspace(lane?.repoPath || session.workspace),
      runtime: session.runtime || 'unknown',
      model: lane?.model ?? session.model ?? null,
      status: canonicalAgentStatus(session, lane),
      branch: lane?.branch || session.branch || 'main',
      elapsed: session.lastEventAt || '',
      sessionKey: session.sessionKey,
      task: session.currentTask || lane?.lastEventLabel || null,
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
