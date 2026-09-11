/**
 * #2141 — what the fleet summary says a watched agent DID.
 *
 * The summary used to derive this from `lastStatus` alone, which the poller
 * sets from the runtime's inventory. A worker that ran to `finished` and then
 * had its completion BLOCKED (zero diff, failed verification, exhausted retry
 * budget — the lane is terminal-failed) kept `lastStatus: 'finished'`, so the
 * escalation reported it as one of the completed agents and closed with "All
 * agents completed successfully." The operator was told to go read results
 * that do not exist.
 *
 * Two halves of one rule live here so they cannot drift: the status a settled
 * completion lands on, and how the summary counts each agent.
 */
import type { WatchedAgent } from './agent-supervisor-types';

export type WatchedAgentOutcome = 'completed' | 'failed' | 'pending';

/**
 * The runtime status a finished agent settles on once its completion callback
 * has ruled. A blocked completion is a failure of THIS run, whatever the
 * runtime's own inventory said.
 */
export function settledCompletionStatus(blocked: boolean): 'finished' | 'failed' {
  return blocked ? 'failed' : 'finished';
}

/**
 * An agent is only `pending` while its completion has not been reported. Once
 * it has, it is `completed` or `failed` — never pending, and never unclassified.
 */
export function watchedAgentOutcome(
  agent: Pick<WatchedAgent, 'completionReported' | 'lastStatus'>,
): WatchedAgentOutcome {
  if (!agent.completionReported) return 'pending';
  return agent.lastStatus === 'finished' ? 'completed' : 'failed';
}
