import type { AgentRuntime, RuntimeSession } from '@/lib/runtimes/types';
import type { AgentSummary, EventItem, FleetSnapshot, SquadSummary } from '@/lib/fleet/types';
import { getOpenClawFleetSnapshot } from '@/lib/openclaw/fleet';
import { codexRuntime } from '@/lib/runtimes/codex';
import { claudeCodeRuntime } from '@/lib/runtimes/claude-code';
import { listIdeRuntimeSessions } from '@/lib/runtime/ide-session-registry';

const RUNTIME_INVENTORY_TTL_MS = 15_000;
const runtimeInventoryCache = new Map<string, { snapshot: FleetSnapshot; cachedAt: number }>();
const runtimeInventoryInflight = new Map<string, { generation: number; promise: Promise<FleetSnapshot> }>();
let runtimeInventoryGeneration = 0;

export function invalidateRuntimeInventoryCache() {
  runtimeInventoryGeneration += 1;
  runtimeInventoryCache.clear();
  runtimeInventoryInflight.clear();
}

function relativeAge(timestamp: Date) {
  const delta = Math.max(0, Date.now() - timestamp.getTime());
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (delta < minute) return 'just now';
  if (delta < hour) return `${Math.max(1, Math.round(delta / minute))}m ago`;
  if (delta < day) return `${Math.max(1, Math.round(delta / hour))}h ago`;
  return `${Math.max(1, Math.round(delta / day))}d ago`;
}

function shortenHomePath(filePath: string) {
  const home = process.env.HOME ?? '';
  return home && filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function defaultRuntimeDisplayName(runtime: AgentRuntime['id']) {
  return runtime === 'claude-code' ? 'Claude Code' : runtime === 'codex' ? 'Codex' : String(runtime);
}

function repoLabelFromSession(session: RuntimeSession, workspace: string) {
  const repoSlug = session.repoSlug?.split('/').pop()?.trim();
  if (repoSlug) return repoSlug;
  const clean = workspace.replace(/^~\//, '').replace(/\/+$/, '');
  const parts = clean.split('/').filter(Boolean);
  return parts[parts.length - 1] || null;
}

function decorateRuntimeDisplayName(runtime: AgentRuntime['id'], displayName: string, session: RuntimeSession, workspace: string) {
  const runtimeName = defaultRuntimeDisplayName(runtime);
  if (displayName.trim().toLowerCase() !== runtimeName.toLowerCase()) {
    return displayName;
  }
  const repoLabel = repoLabelFromSession(session, workspace);
  return repoLabel ? `${repoLabel} · ${runtimeName}` : runtimeName;
}

function runtimeSourceLabel(runtime: AgentRuntime, session: RuntimeSession) {
  if (runtime.id === 'codex') {
    return session.ownership === 'owned'
      ? 'IDE-owned Codex workspace lane'
      : 'Local Codex terminal discovery';
  }
  if (runtime.id === 'claude-code') {
    return 'Local Claude Code terminal discovery';
  }
  return `${runtime.displayName} discovery`;
}

function mapRuntimeSessionToAgent(
  runtime: AgentRuntime,
  session: RuntimeSession,
  overrides?: {
    label?: string;
    model?: string;
    repoPath?: string;
  },
): AgentSummary {
  const contextUsed = Math.max(0, Math.min(100, session.contextUsedPercent ?? 0));
  const workspace = shortenHomePath(overrides?.repoPath ?? session.cwd);
  const alerts = Number(session.status === 'failed') + Number(contextUsed >= 75);
  const rawDisplayName = overrides?.label?.trim() || session.displayName;
  const displayName = decorateRuntimeDisplayName(runtime.id, rawDisplayName, session, workspace);
  const model = overrides?.model || session.model || runtime.displayName;

  return {
    id: session.sessionKey,
    name: displayName,
    squadId: `squad-${runtime.id}`,
    runtime: runtime.id,
    model,
    primaryModel: model,
    status: session.status,
    currentTask: session.initialTask ?? `${runtime.displayName} session`,
    workspace,
    branch: session.branch ?? 'unknown',
    sessionKey: session.sessionKey,
    approvalStatus: 'none',
    lastEventAt: relativeAge(session.lastActivityAt),
    context: {
      usedPercent: contextUsed,
      trend: contextUsed >= 60 ? 'rising' : 'stable',
    },
    alerts,
    sessionId: session.sessionKey.replace(/^[^:]+:/, ''),
    sessionKind: session.ownership,
    surfaceLabel: runtime.displayName,
    tokenUsage: undefined,
    runtimeSurface: {
      id: session.sessionKey,
      runtime: runtime.id,
      kind: 'terminal-session',
      ownership: session.ownership,
      title: displayName,
      cwd: workspace,
      branch: session.branch,
      sourceLabel: runtimeSourceLabel(runtime, session),
      capabilities: {
        attach: true,
        readTail: true,
        sendInput: session.sessionCapabilities.canSendInput,
        interrupt: session.sessionCapabilities.canInterrupt,
        resize: false,
        diffContext: session.sessionCapabilities.canReviewDiffs,
        reviewContext: true,
      },
      lifecycle: session.lifecycle,
      reviewContext: {
        repoSlug: session.repoSlug,
        branch: session.branch,
        head: session.headSha,
      },
      browserSurface: session.browserSurface,
    },
    browserSurface: session.browserSurface,
    tmuxSession: session.tmuxSession,
  };
}

function filterSnapshotToIdeSessions(snapshot: FleetSnapshot) {
  const ideSessions = listIdeRuntimeSessions();
  const ideSessionByKey = new Map(ideSessions.map((session) => [session.sessionKey, session]));
  const keepAgentIds = new Set<string>();

  const agents = snapshot.agents
    .filter((agent) => {
      if (agent.runtime === 'openclaw') return true;
      return ideSessionByKey.has(agent.sessionKey);
    })
    .map((agent) => {
      if (agent.runtime === 'openclaw') {
        keepAgentIds.add(agent.id);
        return agent;
      }

      const ideSession = ideSessionByKey.get(agent.sessionKey);
      const next = ideSession
        ? {
            ...agent,
            name: ideSession.label || agent.name,
            model: ideSession.model || agent.model,
            primaryModel: ideSession.model || agent.primaryModel || agent.model,
            workspace: ideSession.repoPath ? shortenHomePath(ideSession.repoPath) : agent.workspace,
            runtimeSurface: agent.runtimeSurface
              ? {
                  ...agent.runtimeSurface,
                  title: ideSession.label || agent.runtimeSurface.title,
                  cwd: ideSession.repoPath ? shortenHomePath(ideSession.repoPath) : agent.runtimeSurface.cwd,
                }
              : agent.runtimeSurface,
          }
        : agent;
      keepAgentIds.add(next.id);
      return next;
    });

  const squads = snapshot.squads
    .map((squad) => {
      const members = squad.members.filter((member) => keepAgentIds.has(member));
      if (members.length === 0) return null;
      const memberAgents = agents.filter((agent) => members.includes(agent.id));
      return {
        ...squad,
        members,
        liveSessions: members.length,
        blockers: memberAgents.filter((agent) => agent.status === 'blocked' || agent.status === 'failed').length,
        alerts: memberAgents.reduce((sum, agent) => sum + agent.alerts, 0),
      };
    })
    .filter((squad): squad is SquadSummary => Boolean(squad));

  const events = snapshot.events.filter((event) => !event.agentId || keepAgentIds.has(event.agentId));
  const artifacts = snapshot.artifacts.filter((artifact) => !artifact.agentId || keepAgentIds.has(artifact.agentId));
  const primarySessionKey = agents.find((agent) => agent.runtime === 'openclaw' && agent.isCurrentSession)?.sessionKey
    ?? agents.find((agent) => agent.status === 'running')?.sessionKey
    ?? agents[0]?.sessionKey;

  return {
    ...snapshot,
    agents,
    squads,
    events,
    artifacts,
    meta: {
      ...snapshot.meta,
      primarySessionKey,
    },
  };
}

async function buildCliRuntimeSnapshot(): Promise<FleetSnapshot> {
  const runtimes: AgentRuntime[] = [codexRuntime, claudeCodeRuntime].filter((runtime) => runtime.capabilities.discover);
  const ideSessions = listIdeRuntimeSessions();
  const ideSessionByKey = new Map(ideSessions.map((session) => [session.sessionKey, session]));
  const results = await Promise.allSettled(
    runtimes.map(async (runtime) => ({
      runtime,
      sessions: await runtime.discoverSessions(),
    })),
  );

  const discovered = results
    .filter((result): result is PromiseFulfilledResult<{ runtime: AgentRuntime; sessions: RuntimeSession[] }> => result.status === 'fulfilled')
    .flatMap((result) => result.value.sessions
      .filter((session) => ideSessionByKey.has(session.sessionKey))
      .map((session) => ({ runtime: result.value.runtime, session })));

  discovered.sort((left, right) => {
    const statusWeight = (status: RuntimeSession['status']) => (
      status === 'running' ? 5
        : status === 'reviewing' ? 4
          : status === 'waiting' ? 3
            : status === 'failed' ? 2
              : 1
    );
    const statusDelta = statusWeight(right.session.status) - statusWeight(left.session.status);
    if (statusDelta !== 0) return statusDelta;
    return right.session.lastActivityAt.getTime() - left.session.lastActivityAt.getTime();
  });

  const agents = discovered.map(({ runtime, session }) => mapRuntimeSessionToAgent(runtime, session, ideSessionByKey.get(session.sessionKey)));

  const squads: SquadSummary[] = [];
  for (const runtime of runtimes) {
    const members = agents.filter((agent) => agent.runtime === runtime.id);
    if (members.length === 0) continue;
    squads.push({
      id: `squad-${runtime.id}`,
      name: runtime.displayName,
      status: members.some((agent) => agent.status === 'running')
        ? 'healthy'
        : members.some((agent) => agent.status === 'failed' || agent.status === 'blocked')
          ? 'blocked'
          : 'watching',
      throughputLabel: `${members.length} local session${members.length === 1 ? '' : 's'}`,
      blockers: members.filter((agent) => agent.status === 'blocked' || agent.status === 'failed').length,
      alerts: members.reduce((sum, agent) => sum + agent.alerts, 0),
      liveSessions: members.length,
      members: members.map((agent) => agent.id),
    });
  }

  const events: EventItem[] = agents
    .filter((agent) => ['running', 'reviewing', 'failed', 'blocked', 'waiting'].includes(agent.status))
    .slice(0, 8)
    .map((agent) => ({
      id: `evt-${agent.id}`,
      agentId: agent.id,
      squadId: agent.squadId,
      severity: agent.status === 'failed' || agent.status === 'blocked'
        ? 'critical'
        : agent.status === 'running'
          ? 'info'
          : 'warning',
      title: `${agent.name} • ${agent.runtime === 'claude-code' ? 'Claude Code' : 'Codex'}`,
      detail: [agent.currentTask, agent.workspace, agent.lastEventAt].filter(Boolean).join(' • '),
      timestamp: agent.lastEventAt,
    }));

  const primarySessionKey = agents.find((agent) => agent.status === 'running')?.sessionKey ?? agents[0]?.sessionKey;

  return {
    generatedAt: new Date().toISOString(),
    meta: {
      mode: 'live',
      sourceLabel: runtimes.length > 0
        ? `runtime inventory • ${runtimes.map((runtime) => runtime.displayName).join(' + ')}`
        : 'runtime inventory • local CLI runtimes',
      gatewayLabel: 'OpenClaw beta connector disabled',
      mirrorMode: 'current-session-first',
      note: 'OpenClaw beta connector disabled. Showing Codex and Claude Code surfaces only.',
      primarySessionKey,
    },
    squads,
    agents,
    events,
    artifacts: [],
  };
}

export async function getRuntimeInventorySnapshot(
  options: { fleetMode?: 'smart' | 'all'; fresh?: boolean; includeOpenClaw?: boolean } = {},
): Promise<FleetSnapshot> {
  const fleetMode = options.fleetMode ?? 'smart';
  const fresh = options.fresh ?? false;
  const includeOpenClaw = options.includeOpenClaw ?? true;
  const cacheKey = `${fleetMode}:${includeOpenClaw ? 'with-openclaw' : 'cli-only'}`;
  const now = Date.now();
  const generation = runtimeInventoryGeneration;

  if (!fresh) {
    const cached = runtimeInventoryCache.get(cacheKey);
    if (cached && (now - cached.cachedAt) < RUNTIME_INVENTORY_TTL_MS) {
      return cached.snapshot;
    }

    const inflight = runtimeInventoryInflight.get(cacheKey);
    if (inflight && inflight.generation === generation) return inflight.promise;
  }

  const promise = (async () => {
    const rawSnapshot = includeOpenClaw
      ? await getOpenClawFleetSnapshot({ fleetMode, fresh })
      : await buildCliRuntimeSnapshot();
    const snapshot = includeOpenClaw ? filterSnapshotToIdeSessions(rawSnapshot) : rawSnapshot;

    const canCache = snapshot.meta.mode === 'live'
      && (!includeOpenClaw || (snapshot.meta.gatewayFreshness === 'fresh' && !snapshot.meta.observablePending));
    if (generation === runtimeInventoryGeneration && canCache) {
      runtimeInventoryCache.set(cacheKey, { snapshot, cachedAt: Date.now() });
    }
    return snapshot;
  })();

  runtimeInventoryInflight.set(cacheKey, { generation, promise });
  return promise.finally(() => {
    const current = runtimeInventoryInflight.get(cacheKey);
    if (current?.promise === promise) {
      runtimeInventoryInflight.delete(cacheKey);
    }
  });
}
