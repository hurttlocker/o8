import path from 'node:path';
import type { AgentRuntime, RuntimeSession } from '@/lib/runtimes/types';
import type { AgentSummary, EventItem, FleetSnapshot, SquadSummary } from '@/lib/fleet/types';
import { codexRuntime } from '@/lib/runtimes/codex';
import { claudeCodeRuntime } from '@/lib/runtimes/claude-code';
import { listCurrentIdeRepoPaths } from '@/lib/runtime/ide-terminal-state';
import { listIdeRuntimeSessions, listIdeRuntimeTabs, type IdeRuntimeSessionDescriptor } from '@/lib/runtime/ide-session-registry';
import { getRuntimeTerminalSession } from '@/lib/runtime/terminal-session-registry';

const RUNTIME_INVENTORY_TTL_MS = 15_000;
const RUNTIME_INVENTORY_FRESH_COALESCE_MS = 2_000;
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
    lastActivityAt: session.lastActivityAt.getTime(),
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

function mapIdeGhostRuntimeTabToAgent(session: IdeRuntimeSessionDescriptor): AgentSummary {
  const workspace = shortenHomePath(session.repoPath ?? '~/clawd');
  const runtimeName = defaultRuntimeDisplayName(session.runtimeId);
  const currentTask = session.liveSessionKey
    ? 'Reconnecting\u2026'
    : 'Idle';
  const parsedLastActivity = new Date(session.savedAt ?? Date.now()).getTime();

  return {
    id: session.sessionKey,
    name: session.label,
    squadId: `squad-${session.runtimeId}`,
    runtime: session.runtimeId,
    model: session.model || runtimeName,
    primaryModel: session.model || runtimeName,
    status: 'idle',
    currentTask,
    workspace,
    branch: 'unknown',
    sessionKey: session.sessionKey,
    approvalStatus: 'none',
    lastEventAt: relativeAge(new Date(session.savedAt ?? Date.now())),
    lastActivityAt: Number.isNaN(parsedLastActivity) ? Date.now() : parsedLastActivity,
    context: {
      usedPercent: 0,
      trend: 'stable',
    },
    alerts: 0,
    sessionId: session.tabId,
    sessionKind: 'discovered',
    surfaceLabel: runtimeName,
    isCurrentSession: session.isCurrentSession,
    tokenUsage: undefined,
    runtimeSurface: {
      id: session.sessionKey,
      runtime: session.runtimeId,
      kind: 'chat-session',
      ownership: 'discovered',
      title: session.label,
      cwd: workspace,
      branch: 'unknown',
      sourceLabel: session.liveSessionKey
        ? 'Reconnecting…'
        : 'Idle',
      capabilities: {
        attach: false,
        readTail: true,
        sendInput: false,
        interrupt: false,
        resize: false,
        diffContext: true,
        reviewContext: true,
      },
    },
  };
}

function isRegistryBackedRuntimeSession(sessionKey: string) {
  return Boolean(getRuntimeTerminalSession(sessionKey));
}

function normalizeInventoryWorkspacePath(workspace?: string | null) {
  const trimmed = workspace?.trim();
  if (!trimmed) return null;
  const home = process.env.HOME ?? '';
  const expanded = trimmed.startsWith('~/') && home
    ? path.join(home, trimmed.slice(2))
    : trimmed === '~' && home
      ? home
      : trimmed;
  return path.normalize(expanded).toLowerCase();
}

function selectRepoFallbackAgents(agents: AgentSummary[], existingSessionKeys: Set<string>) {
  const currentRepoPaths = new Set(listCurrentIdeRepoPaths());
  if (currentRepoPaths.size === 0) return [] as AgentSummary[];

  const selected: AgentSummary[] = [];
  const seenRepoRuntime = new Set<string>();

  for (const agent of agents) {
    if (existingSessionKeys.has(agent.sessionKey)) continue;
    if (agent.runtime !== 'codex' && agent.runtime !== 'claude-code') continue;
    if (!['running', 'reviewing', 'waiting'].includes(agent.status)) continue;
    // Only include IDE-owned sessions as fallbacks — discovered user-terminal
    // sessions shouldn't appear as phantom agents when the runtime restarts.
    if (!agent.sessionKey.startsWith('codex-owned:') && !isRegistryBackedRuntimeSession(agent.sessionKey)) continue;

    const workspaceKey = normalizeInventoryWorkspacePath(agent.runtimeSurface?.cwd ?? agent.workspace);
    if (!workspaceKey || !currentRepoPaths.has(workspaceKey)) continue;

    const bucketKey = `${agent.runtime}:${workspaceKey}`;
    if (seenRepoRuntime.has(bucketKey)) continue;
    seenRepoRuntime.add(bucketKey);
    selected.push(agent);
  }

  return selected;
}

async function buildCliRuntimeSnapshot(): Promise<FleetSnapshot> {
  const runtimes: AgentRuntime[] = [codexRuntime, claudeCodeRuntime].filter((runtime) => runtime.capabilities.discover);
  const ideSessions = listIdeRuntimeSessions();
  const ideTabs = listIdeRuntimeTabs();
  const ideSessionByKey = new Map(ideSessions.map((session) => [session.liveSessionKey ?? session.sessionKey, session]));
  const results = await Promise.allSettled(
    runtimes.map(async (runtime) => ({
      runtime,
      sessions: await runtime.discoverSessions(),
    })),
  );

  const discoveredAll = results
    .filter((result): result is PromiseFulfilledResult<{ runtime: AgentRuntime; sessions: RuntimeSession[] }> => result.status === 'fulfilled')
    .flatMap((result) => result.value.sessions.map((session) => ({ runtime: result.value.runtime, session })));

  discoveredAll.sort((left, right) => {
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

  const discovered = discoveredAll.filter(({ session }) => (
    session.sessionKey?.startsWith('codex-owned:')
    || ideSessionByKey.has(session.sessionKey)
    || isRegistryBackedRuntimeSession(session.sessionKey)
  ));

  const agents = discovered.map(({ runtime, session }) => mapRuntimeSessionToAgent(runtime, session, ideSessionByKey.get(session.sessionKey)));
  const fallbackAgents = selectRepoFallbackAgents(
    discoveredAll.map(({ runtime, session }) => mapRuntimeSessionToAgent(runtime, session, ideSessionByKey.get(session.sessionKey))),
    new Set(agents.map((agent) => agent.sessionKey)),
  );
  agents.push(...fallbackAgents);

  const liveSessionKeys = new Set(
    [...discovered, ...discoveredAll.filter(({ session }) => fallbackAgents.some((agent) => agent.sessionKey === session.sessionKey))]
      .map(({ session }) => session.sessionKey),
  );
  const ghostAgents = ideTabs
    .filter((tab) => !tab.liveSessionKey || !liveSessionKeys.has(tab.liveSessionKey))
    .map(mapIdeGhostRuntimeTabToAgent);
  agents.push(...ghostAgents);

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

  const primarySessionKey = agents.find((agent) => agent.isCurrentSession)?.sessionKey
    ?? agents.find((agent) => agent.status === 'running')?.sessionKey
    ?? agents[0]?.sessionKey;

  return {
    generatedAt: new Date().toISOString(),
    meta: {
      mode: 'live',
      sourceLabel: runtimes.length > 0
        ? `runtime inventory • ${runtimes.map((runtime) => runtime.displayName).join(' + ')}`
        : 'runtime inventory • local CLI runtimes',
      gatewayLabel: 'Runtime inventory ready',
      gatewayFreshness: 'fresh',
      gatewayReachable: true,
      mirrorMode: 'current-session-first',
      observablePending: false,
      note: 'Showing Codex and Claude Code runtime surfaces only.',
      primarySessionKey,
    },
    squads,
    agents,
    events,
    artifacts: [],
  };
}

export async function getRuntimeInventorySnapshot(
  options: { fleetMode?: 'smart' | 'all'; fresh?: boolean } = {},
): Promise<FleetSnapshot> {
  const fleetMode = options.fleetMode ?? 'smart';
  const fresh = options.fresh ?? false;
  const cacheKey = fleetMode;
  const now = Date.now();
  const generation = runtimeInventoryGeneration;

  const cached = runtimeInventoryCache.get(cacheKey);
  const maxCacheAge = fresh ? RUNTIME_INVENTORY_FRESH_COALESCE_MS : RUNTIME_INVENTORY_TTL_MS;
  if (cached && (now - cached.cachedAt) < maxCacheAge) {
    return cached.snapshot;
  }

  const inflight = runtimeInventoryInflight.get(cacheKey);
  if (inflight && inflight.generation === generation) {
    return inflight.promise;
  }

  const promise = (async () => {
    const snapshot = await buildCliRuntimeSnapshot();

    // ── Reconcile lanes with discovered sessions ���─
    try {
      const { reconcileLanesWithSessions } = await import('@/lib/lane/registry');
      const sessionSummaries = snapshot.agents
        .filter((agent) => agent.sessionKey && (agent.runtime === 'codex' || agent.runtime === 'claude-code'))
        .map((agent) => ({
          sessionKey: agent.sessionKey,
          runtimeId: agent.runtime,
          cwd: agent.workspace ?? '',
          branch: agent.branch,
          status: agent.status,
        }));
      if (sessionSummaries.length > 0) {
        const pendingReviewCommits = reconcileLanesWithSessions(sessionSummaries);

        // #454 — Auto-commit dirty worktrees for lanes that just transitioned to reviewing.
        // This runs after the synchronous DB transaction so git operations don't block it.
        if (pendingReviewCommits.length > 0) {
          const { autoCommitCompletionWorktree } = await import('@/lib/supervisor/completion-verification');
          await Promise.allSettled(
            pendingReviewCommits.map(async ({ laneId, worktreePath }) => {
              try {
                const committed = await autoCommitCompletionWorktree(worktreePath);
                if (committed) {
                  console.log(`[lane-review] Auto-committed dirty worktree for lane ${laneId} at ${worktreePath}`);
                }
              } catch (err) {
                console.warn(`[lane-review] Auto-commit failed for lane ${laneId}:`, err);
              }
            }),
          );
        }
      }
    } catch {
      // Lane reconciliation is non-critical
    }

    const canCache = snapshot.meta.mode === 'live'
      && snapshot.meta.gatewayFreshness === 'fresh'
      && !snapshot.meta.observablePending;
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
