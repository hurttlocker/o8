import type { AgentSummary } from '@/lib/fleet/types';
import { listApprovals } from '@/lib/approvals/store';
import { listLanes } from '@/lib/lane/registry';
import { resolveAgentSummaryStatusEvidence } from '@/lib/orchestrator/operator-status-model';
import { listRecentDashboardCliSessions } from '@/lib/runtime/terminal-session-registry';

/** Add durable approval sources to the dashboard inventory's shared status evidence. */
export function addInventoryApprovalEvidence(agents: AgentSummary[]): void {
  try {
    const pendingApprovals = listApprovals({ status: 'pending' });
    if (pendingApprovals.length === 0) return;
    const eligibleBindings = new Map([
      ...listRecentDashboardCliSessions('codex'),
      ...listRecentDashboardCliSessions('claude-code'),
    ].map((binding) => [binding.sessionKey, binding] as const));
    const lanesBySession = new Map(listLanes()
      .filter((lane) => Boolean(lane.sessionKey))
      .map((lane) => [lane.sessionKey!, lane] as const));
    for (let index = 0; index < agents.length; index += 1) {
      const agent = agents[index];
      const lane = lanesBySession.get(agent.sessionKey);
      if (!pendingApprovals.some((approval) => (
        approval.sessionKey === agent.sessionKey
        || (lane && approval.continuation?.kind === 'lane' && approval.continuation.laneId === lane.id)
      ))) continue;
      agents[index] = {
        ...agent,
        statusEvidence: resolveAgentSummaryStatusEvidence(agent, lane, { approvals: pendingApprovals }),
        terminalApprovalEligible: agent.sessionKind === 'discovered'
          && Boolean(agent.tmuxSession)
          && eligibleBindings.get(agent.sessionKey)?.sessionName === agent.tmuxSession
          && eligibleBindings.get(agent.sessionKey)?.runtime === agent.runtime,
      };
    }
  } catch (error) {
    // Runtime discovery remains available when the approval store is unavailable.
    console.warn('[runtime/inventory] Approval evidence unavailable:', error);
  }
}
