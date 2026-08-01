import { basename } from 'node:path';
import { listLanes } from '@/lib/lane/registry';
import { agentDisplayLabel } from '@/lib/orchestrator/display';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import type { SearchResult } from '@/lib/search/types';

function parseAgentTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export async function searchAgents(query: string, browse = false): Promise<SearchResult[]> {
  const lowered = query.toLowerCase();
  const out: SearchResult[] = [];
  const seenSessionKeys = new Set<string>();

  try {
    const snapshot = await getRuntimeInventorySnapshot();
    for (const agent of snapshot.agents) {
      const sessionKey = agent.sessionKey || agent.id;
      if (!sessionKey) continue;
      const name = agentDisplayLabel({
        name: agent.name,
        sessionKey,
        runtime: agent.runtime,
      });
      const matchedName = name.toLowerCase().includes(lowered);
      const matchedTask = (agent.currentTask ?? '').toLowerCase().includes(lowered);
      const matchedModel = (agent.model ?? '').toLowerCase().includes(lowered);
      const matchedBranch = (agent.branch ?? '').toLowerCase().includes(lowered);
      const matchedWorkspace = (agent.workspace ?? '').toLowerCase().includes(lowered);
      const matchedStatus = String(agent.status ?? '').toLowerCase().includes(lowered);
      const strongRetiredMatch = matchedName || (agent.workspace ?? '').toLowerCase() === lowered;
      if (!browse && (
        (!matchedName && !matchedTask && !matchedModel && !matchedBranch && !matchedWorkspace && !matchedStatus)
        || (agent.status === 'completed' && !strongRetiredMatch)
      )) continue;

      const detailParts = [agent.status, agent.runtime, agent.branch].filter(Boolean).map(String);
      out.push({
        kind: 'agent',
        id: `agent:${sessionKey}`,
        title: name,
        detail: detailParts.join(' · ') || (agent.currentTask ?? '').slice(0, 80),
        target: { sessionKey },
        score: browse
          ? 1_000_000 + (agent.lastActivityAt ?? 0)
          : 40
            + (matchedName ? 30 : 0)
            + (matchedTask ? 12 : 0)
            + (matchedBranch ? 8 : 0)
            + (matchedWorkspace ? 6 : 0)
            + (matchedModel ? 4 : 0)
            + (matchedStatus ? 2 : 0),
      });
      seenSessionKeys.add(sessionKey);
    }
  } catch {
    // The durable lanes below still make the palette useful when discovery is down.
  }

  let laneList: ReturnType<typeof listLanes> = [];
  try {
    laneList = listLanes()
      .filter((lane) => Boolean(lane.sessionKey))
      .sort((left, right) => (
        parseAgentTimestamp(right.lastEventAt ?? right.updatedAt ?? right.createdAt)
        - parseAgentTimestamp(left.lastEventAt ?? left.updatedAt ?? left.createdAt)
      ));
  } catch {
    return out;
  }

  const activeLanes = laneList.filter((lane) => (
    lane.status !== 'archived' && lane.status !== 'completed' && lane.status !== 'failed'
  ));
  const browseLanes = activeLanes.length > 0
    ? activeLanes.slice(0, 8)
    : out.length === 0 ? laneList.slice(0, 8) : [];
  const candidates = browse ? browseLanes : laneList;

  for (const lane of candidates) {
    const sessionKey = lane.sessionKey;
    if (!sessionKey || seenSessionKeys.has(sessionKey)) continue;
    const repoName = basename(lane.repoPath);
    const label = agentDisplayLabel({
      name: lane.label,
      sessionKey,
      runtime: lane.runtime,
    });
    const labelMatch = label.toLowerCase().includes(lowered);
    const repoMatch = repoName.toLowerCase().includes(lowered) || lane.repoPath.toLowerCase().includes(lowered);
    const branchMatch = lane.branch.toLowerCase().includes(lowered);
    const runtimeMatch = lane.runtime.toLowerCase().includes(lowered);
    const statusMatch = lane.status.toLowerCase().includes(lowered);
    const eventMatch = (lane.lastEventLabel ?? '').toLowerCase().includes(lowered);
    const matches = labelMatch || repoMatch || branchMatch || runtimeMatch || statusMatch || eventMatch;
    const retired = lane.status === 'archived' || lane.status === 'completed';
    const strongRetiredMatch = labelMatch
      || repoName.toLowerCase() === lowered
      || lane.branch.toLowerCase() === lowered;
    if (!browse && (!matches || (retired && !strongRetiredMatch))) continue;

    out.push({
      kind: 'agent',
      id: `agent:${sessionKey}`,
      title: label,
      detail: [lane.status, repoName, lane.runtime].join(' · '),
      target: { sessionKey },
      score: browse
        ? parseAgentTimestamp(lane.lastEventAt ?? lane.updatedAt ?? lane.createdAt)
        : 35
          + (labelMatch ? 35 : 0)
          + (repoMatch ? 10 : 0)
          + (branchMatch ? 8 : 0)
          + (runtimeMatch ? 5 : 0)
          + (eventMatch ? 3 : 0)
          - (retired ? 20 : 0),
    });
    seenSessionKeys.add(sessionKey);
    if (!browse && out.length >= 12) break;
  }

  return out.sort((left, right) => right.score - left.score);
}
