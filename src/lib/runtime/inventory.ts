// Inventory aggregation. See docs/internals/runtime-adapter-contract.md
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, RuntimeSession } from '@/lib/runtimes/types';
import type { AgentSummary, EventItem, FleetSnapshot, SquadSummary } from '@/lib/fleet/types';
import { getAllRuntimes } from '@/lib/runtimes';
import { listCurrentIdeRepoPaths } from '@/lib/runtime/ide-terminal-state';
import { listIdeRuntimeSessions, listIdeRuntimeTabs, type IdeRuntimeSessionDescriptor } from '@/lib/runtime/ide-session-registry';
import { getRuntimeTerminalSession } from '@/lib/runtime/terminal-session-registry';
import { readSessionTransformCatalog } from '@/lib/runtime/session-transform-catalog';
import { invalidateProcessCwdSnapshot } from '@/lib/runtime/process-cwd-snapshot';
import {
  isDispatchableRuntime,
  ORCHESTRATOR_RUNTIMES,
} from '@/lib/orchestrator/runtime-capabilities';
import { getAllEvents, getLaneEvents, listLanes } from '@/lib/lane/registry';
import type { Lane, LaneEvent } from '@/lib/lane/types';
import { debouncedSessionStatus } from '@/lib/terminal-status/debounce';
import {
  compareTerminalStatusEvidence,
  resolveTerminalStatusEvidence,
  runtimeSessionStatusFromTerminalState,
  unknownTerminalStatusEvidence,
  type TerminalStatusEvidence,
} from '@/lib/terminal-status/resolve';

export { debouncedSessionStatus } from '@/lib/terminal-status/debounce';

const RUNTIME_INVENTORY_TTL_MS = 15_000;
const RUNTIME_INVENTORY_FRESH_COALESCE_MS = 2_000;
const RUNTIME_INVENTORY_IDLE_TTL_MS = 30_000;
// Hard ceiling on how long a single snapshot build can take before we serve
// the prior cached snapshot (or an empty shell) and let discovery finish in
// the background. When the local codex sessions directory has hundreds of
// stale entries, discoverSessions balloons past 10s and the client fetch
// surfaces as a 'Load failed' TypeError in the Next.js dev overlay.
const RUNTIME_INVENTORY_BUILD_TIMEOUT_MS = 3_500;
const runtimeInventoryCache = new Map<string, { snapshot: FleetSnapshot; cachedAt: number; idle: boolean }>();
const runtimeInventoryInflight = new Map<string, { generation: number; promise: Promise<FleetSnapshot> }>();
let runtimeInventoryGeneration = 0;
// #1293 — retire dead/orphaned owned-session corpses continuously, not just at
// startup (ws-server). Debounced so a 15s inventory tick doesn't re-list every
// session dir on every build; the sweep is fire-and-forget and never blocks.
const ORPHAN_SWEEP_DEBOUNCE_MS = 60_000;
let lastOrphanSweepAt = 0;

/** @returns {void} */
export function invalidateRuntimeInventoryCache() {
  runtimeInventoryGeneration += 1;
  runtimeInventoryCache.clear();
  runtimeInventoryInflight.clear();
  invalidateProcessCwdSnapshot();
}

function inventoryHasOwnedOrLiveSession(snapshot: FleetSnapshot): boolean {
  return snapshot.agents.some((agent) => (
    agent.runtimeSurface?.ownership === 'owned'
    || ['running', 'waiting', 'reviewing', 'huddling'].includes(agent.status)
  ));
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
  // Capability-map lookup; optional chaining guards against runtimes not yet in the map.
  return ORCHESTRATOR_RUNTIMES[runtime as keyof typeof ORCHESTRATOR_RUNTIMES]?.label ?? String(runtime);
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

function eventPayloadString(event: LaneEvent, key: string): string | null {
  const value = event.payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function laneRepoLabel(lane: Lane | undefined): string | undefined {
  const repoPath = lane?.repoPath.trim().replace(/\/+$/, '');
  if (!repoPath) return undefined;
  return repoPath.split('/').filter(Boolean).pop();
}

function isHuddleLane(lane: Lane): boolean {
  return lane.status === 'awaiting_orchestrator'
    && (lane.lastEventLabel === 'huddle' || lane.lastEventLabel === 'huddle_ready');
}

function huddlePlan(lane: Lane): string | undefined {
  const event = [...getLaneEvents(lane.id, 100)]
    .reverse()
    .find((candidate) => candidate.verb === 'agent_report' && candidate.payload.event === 'huddle');
  const message = event?.payload.message;
  return typeof message === 'string' && message.trim() ? message.trim() : undefined;
}

function applyHuddleLaneStatus(agents: AgentSummary[]): AgentSummary[] {
  let huddleBySessionKey: Map<string, Lane>;
  try {
    huddleBySessionKey = new Map(
      listLanes()
        .filter((lane) => lane.sessionKey && isHuddleLane(lane))
        .map((lane) => [lane.sessionKey as string, lane]),
    );
  } catch {
    return agents;
  }
  if (huddleBySessionKey.size === 0) return agents;

  return agents.map((agent) => {
    const lane = huddleBySessionKey.get(agent.sessionKey);
    if (!lane) return agent;
    return {
      ...agent,
      status: 'huddling',
      currentTask: agent.currentTask || 'Huddling — awaiting orchestrator alignment',
      huddlePlan: huddlePlan(lane),
      alerts: Math.max(0, agent.alerts - Number(agent.status === 'failed' || agent.status === 'blocked')),
      lastEventAt: lane.lastEventAt ? relativeAge(new Date(lane.lastEventAt)) : agent.lastEventAt,
    };
  });
}

function readAgentReportEvents(): EventItem[] {
  try {
    const lanesById = new Map(listLanes().map((lane) => [lane.id, lane]));
    return getAllEvents(80)
      .filter((event) => event.verb === 'agent_report')
      .slice(-8)
      .map((event) => {
        const lane = lanesById.get(event.laneId);
        const reportEvent = eventPayloadString(event, 'event') ?? 'progress';
        const reason = eventPayloadString(event, 'reason');
        const message = eventPayloadString(event, 'message');
        const packetId = eventPayloadString(event, 'packetId') ?? lane?.packetId ?? null;
        return {
          id: event.id,
          agentId: lane?.sessionKey ?? lane?.id ?? event.laneId,
          squadId: lane ? `squad-${lane.runtime}` : undefined,
          severity: reportEvent === 'blocked'
            ? 'critical'
            : reportEvent === 'question'
              ? 'warning'
              : 'info',
          title: lane?.label ?? packetId ?? event.laneId,
          track: 'Agent reports',
          subLabel: reportEvent,
          detail: message ?? reason ?? packetId ?? 'Packet agent reported progress.',
          timestamp: event.timestamp,
          repo: laneRepoLabel(lane),
        } satisfies EventItem;
      });
  } catch {
    return [];
  }
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
  statusEvidence: TerminalStatusEvidence,
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
    statusEvidence,
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
    identityId: session.identityId,
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
  const workspace = shortenHomePath(session.repoPath ?? '~');
  const runtimeName = defaultRuntimeDisplayName(session.runtimeId);
  const currentTask = session.liveSessionKey
    ? 'Reconnecting\u2026'
    : 'Idle';
  const parsedLastActivity = new Date(session.savedAt ?? Date.now()).getTime();
  const observedAt = new Date(Number.isNaN(parsedLastActivity) ? Date.now() : parsedLastActivity).toISOString();
  const statusEvidence = resolveTerminalStatusEvidence({
    rawLifecycle: {
      sessionId: session.sessionKey,
      runtime: session.runtimeId,
      state: session.liveSessionKey ? 'unknown' : 'idle',
      observedAt,
    },
  });

  return {
    id: session.sessionKey,
    name: session.label,
    squadId: `squad-${session.runtimeId}`,
    runtime: session.runtimeId,
    model: session.model || runtimeName,
    primaryModel: session.model || runtimeName,
    status: 'idle',
    statusEvidence,
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
    if (!isDispatchableRuntime(agent.runtime)) continue;
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
  const runtimes: AgentRuntime[] = getAllRuntimes()
    .filter((runtime) => runtime.capabilities.discover && isDispatchableRuntime(runtime.id));
  const ideSessions = listIdeRuntimeSessions();
  const ideTabs = listIdeRuntimeTabs();
  const ideSessionByKey = new Map(ideSessions.map((session) => [session.liveSessionKey ?? session.sessionKey, session]));
  const [results, transformCatalog] = await Promise.all([
    Promise.allSettled(runtimes.map(async (runtime) => ({
      runtime,
      sessions: await runtime.discoverSessions(),
    }))),
    readSessionTransformCatalog().catch(() => null),
  ]);
  const catalogedSessionKeys = new Set(
    (transformCatalog?.sessions ?? []).map((session) => `${session.runtimeId}:${session.sessionKey}`),
  );

  const discoveredAll = results
    .filter((result): result is PromiseFulfilledResult<{ runtime: AgentRuntime; sessions: RuntimeSession[] }> => result.status === 'fulfilled')
    .flatMap((result) => result.value.sessions.map((session) => ({ runtime: result.value.runtime, session })))
    // Drop ghost sessions whose cwd doesn't exist on disk. Owned codex
    // sessions survive lane archival and worktree removal because codex
    // keeps its own session registry — they'd otherwise flood the left
    // sidebar with cards pointing at paths that were deleted long ago.
    // Also catches sessions whose repo was moved or removed (e.g. old
    // ~/cortex/ide paths from a rename). Only absolute paths get checked;
    // placeholder cwds like 'unknown' or relative strings pass through so
    // sessions that haven't reported a real path yet aren't dropped.
    .filter(({ session }) => {
      const cwd = (session.cwd || '').trim();
      if (!cwd) return true;
      const expanded = cwd.startsWith('~') ? cwd.replace(/^~/, os.homedir()) : cwd;
      if (!path.isAbsolute(expanded)) return true;
      try {
        return existsSync(expanded);
      } catch {
        return false;
      }
    });

  const discoveredKeys = new Set(
    discoveredAll.map(({ runtime, session }) => `${runtime.id}:${session.sessionKey}`),
  );
  for (const catalogSession of transformCatalog?.sessions ?? []) {
    const runtime = runtimes.find((candidate) => candidate.id === catalogSession.runtimeId);
    const key = `${catalogSession.runtimeId}:${catalogSession.sessionKey}`;
    if (!runtime || discoveredKeys.has(key)) continue;
    const cwd = catalogSession.cwd.trim();
    if (path.isAbsolute(cwd) && !existsSync(cwd)) continue;
    discoveredAll.push({
      runtime,
      session: {
        sessionKey: catalogSession.sessionKey,
        runtimeId: runtime.id,
        displayName: catalogSession.displayName?.trim() || runtime.displayName,
        cwd: catalogSession.cwd,
        branch: catalogSession.branch ?? undefined,
        status: 'idle',
        ownership: catalogSession.ownership,
        sessionCapabilities: {
          canSendInput: runtime.capabilities.resume,
          canInterrupt: false,
          canReviewDiffs: runtime.capabilities.reviewDiffs,
        },
        lastActivityAt: new Date(catalogSession.importedAt),
        identityId: catalogSession.identityId ?? undefined,
      },
    });
    discoveredKeys.add(key);
  }

  // resolveTerminalStatusEvidence is the single source for status precedence.
  const resolvedDiscoveredAll = discoveredAll.map(({ runtime, session }) => {
    const debouncedStatus = debouncedSessionStatus(
      session.sessionKey,
      session.status,
    ) as RuntimeSession['status'];
    let statusEvidence: TerminalStatusEvidence;
    try {
      statusEvidence = resolveTerminalStatusEvidence({
        runtimeSession: {
          sessionKey: session.sessionKey,
          runtimeId: runtime.id,
          status: debouncedStatus,
          observedAt: session.lastActivityAt instanceof Date
            && Number.isFinite(session.lastActivityAt.getTime())
            ? session.lastActivityAt.toISOString()
            : '',
          lifecycle: session.lifecycle,
        },
      });
    } catch (error) {
      const sessionId = session.sessionKey || session.displayName || 'unknown-session';
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[terminal-status] Failed to resolve status for ${sessionId}: ${message}`);
      statusEvidence = unknownTerminalStatusEvidence({
        sessionId,
        runtime: runtime.id,
        observedAt: session.lastActivityAt,
        summary: 'Terminal status evidence could not be resolved for this session.',
        fallbackReason: `Status resolution failed for this session: ${message}`,
      });
    }
    return {
      runtime,
      session: {
        ...session,
        status: runtimeSessionStatusFromTerminalState(statusEvidence.state, debouncedStatus),
      },
      statusEvidence,
    };
  });
  resolvedDiscoveredAll.sort((left, right) => (
    compareTerminalStatusEvidence(left.statusEvidence, right.statusEvidence)
  ));

  const discovered = resolvedDiscoveredAll.filter(({ runtime, session }) => (
    session.sessionKey?.startsWith('codex-owned:')
    || ideSessionByKey.has(session.sessionKey)
    || isRegistryBackedRuntimeSession(session.sessionKey)
    || catalogedSessionKeys.has(`${runtime.id}:${session.sessionKey}`)
    // #658 — Orchestrator-spawned lanes mark themselves with ownership='owned'
    // when their cwd lives inside `.cortex-worktrees/packet-*`. Surface them
    // so the desktop SessionVisualizer + AgentPanel can show their pills and
    // route transcript reads. Without this they'd be filtered out because
    // they're not in the IDE registry (orchestrator dispatch doesn't touch
    // the IDE workspace tabs) and not in the terminal-session registry
    // (orchestrator goes through the bridge terminal, not user PTY).
    || (session.ownership === 'owned' && isDispatchableRuntime(session.runtimeId))
  ));

  const agents = discovered.map(({ runtime, session, statusEvidence }) => (
    mapRuntimeSessionToAgent(runtime, session, statusEvidence, ideSessionByKey.get(session.sessionKey))
  ));
  const fallbackAgents = selectRepoFallbackAgents(
    resolvedDiscoveredAll.map(({ runtime, session, statusEvidence }) => (
      mapRuntimeSessionToAgent(runtime, session, statusEvidence, ideSessionByKey.get(session.sessionKey))
    )),
    new Set(agents.map((agent) => agent.sessionKey)),
  );
  agents.push(...fallbackAgents);
  const visibleAgents = applyHuddleLaneStatus(agents);

  const liveSessionKeys = new Set(
    [...discovered, ...resolvedDiscoveredAll.filter(({ session }) => fallbackAgents.some((agent) => agent.sessionKey === session.sessionKey))]
      .map(({ session }) => session.sessionKey),
  );
  // Ghost-agent promotion: tabs whose session isn't in the live set become
  // "ghost" entries in the sidebar so users can inspect or dismiss them.
  // Keep the existing behavior for tabs without a liveSessionKey (synthetic
  // persistent surfaces like the orchestrator tab) and for non-codex-owned
  // tabs. Codex-owned sessions never resurrect — once codex's own session
  // registry stops reporting them, they're permanently dead and cluttering
  // the sidebar serves no purpose. Drop them at the filter instead of
  // letting the persisted tab files resurrect the ghosts on every render.
  const ghostAgents = ideTabs
    .filter((tab) => {
      if (!tab.liveSessionKey) return true;
      if (liveSessionKeys.has(tab.liveSessionKey)) return false;
      if (tab.liveSessionKey.startsWith('codex-owned:')) return false;
      return true;
    })
    .map(mapIdeGhostRuntimeTabToAgent);
  visibleAgents.push(...ghostAgents);

  const squads: SquadSummary[] = [];
  for (const runtime of runtimes) {
    const members = visibleAgents.filter((agent) => agent.runtime === runtime.id);
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

  const agentReportEvents = readAgentReportEvents();
  const events: EventItem[] = [
    ...agentReportEvents,
    ...visibleAgents
    .filter((agent) => ['running', 'huddling', 'reviewing', 'failed', 'blocked', 'waiting'].includes(agent.status))
    .slice(0, 8)
    .map((agent): EventItem => ({
      id: `evt-${agent.id}`,
      agentId: agent.id,
      squadId: agent.squadId,
      severity: agent.status === 'failed' || agent.status === 'blocked'
        ? 'critical'
        : agent.status === 'running'
          ? 'info'
          : 'warning',
      title: `${agent.name} • ${ORCHESTRATOR_RUNTIMES[agent.runtime as keyof typeof ORCHESTRATOR_RUNTIMES]?.label ?? agent.runtime}`,
      detail: [agent.currentTask, agent.workspace, agent.lastEventAt].filter(Boolean).join(' • '),
      timestamp: agent.lastEventAt,
    })),
  ];

  const primarySessionKey = visibleAgents.find((agent) => agent.isCurrentSession)?.sessionKey
    ?? visibleAgents.find((agent) => agent.status === 'running')?.sessionKey
    ?? visibleAgents[0]?.sessionKey;

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
      note: 'Showing every discovered dispatchable runtime surface.',
      primarySessionKey,
    },
    squads,
    agents: visibleAgents,
    events,
    artifacts: [],
  };
}

function buildEmptyInventorySnapshot(): FleetSnapshot {
  return {
    meta: {
      mode: 'stale',
      sourceLabel: 'Runtime inventory warming',
      mirrorMode: 'current-session-first',
      gatewayFreshness: 'warming',
      observablePending: true,
      note: 'Runtime inventory is still warming up — showing last known state.',
    },
    generatedAt: new Date().toISOString(),
    squads: [],
    agents: [],
    events: [],
    artifacts: [],
  };
}

/** @returns {Promise<FleetSnapshot>} The runtime inventory snapshot */
export async function getRuntimeInventorySnapshot(
  options: { fresh?: boolean } = {},
): Promise<FleetSnapshot> {
  const fresh = options.fresh ?? false;
  const cacheKey = 'default';
  const now = Date.now();
  const generation = runtimeInventoryGeneration;

  const cached = runtimeInventoryCache.get(cacheKey);
  const maxCacheAge = cached?.idle
    ? RUNTIME_INVENTORY_IDLE_TTL_MS
    : fresh
      ? RUNTIME_INVENTORY_FRESH_COALESCE_MS
      : RUNTIME_INVENTORY_TTL_MS;
  if (cached && (now - cached.cachedAt) < maxCacheAge) {
    return cached.snapshot;
  }

  const inflight = runtimeInventoryInflight.get(cacheKey);
  if (inflight && inflight.generation === generation) {
    // Race the inflight build against our hard timeout. If the build is slow
    // (ghost-session flood), serve whatever cached snapshot we have rather
    // than block the client for 7-10s.
    return Promise.race([
      inflight.promise,
      new Promise<FleetSnapshot>((resolve) => {
        setTimeout(() => resolve(cached?.snapshot ?? buildEmptyInventorySnapshot()), RUNTIME_INVENTORY_BUILD_TIMEOUT_MS);
      }),
    ]);
  }

  const promise = (async () => {
    const snapshot = await buildCliRuntimeSnapshot();

    // ── Reconcile lanes with discovered sessions ���─
    try {
      const { reconcileLanesWithSessions } = await import('@/lib/lane/registry');
      const sessionSummaries = snapshot.agents
        .filter((agent) => agent.sessionKey && isDispatchableRuntime(agent.runtime))
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

    // #1293 — self-heal: archive owned-session dirs that are dead and unbound
    // (or bound only to a terminal lane) so corpses can't accumulate between
    // restarts, inflate the agent count, or wedge the build. The startup sweep
    // only fired once; this runs it on every build (debounced). Background +
    // best-effort — it never blocks or fails the snapshot.
    if (Date.now() - lastOrphanSweepAt > ORPHAN_SWEEP_DEBOUNCE_MS) {
      lastOrphanSweepAt = Date.now();
      void import('@/lib/lane/sweep-orphan-sessions')
        .then((m) => m.sweepOrphanedOwnedSessions())
        .catch(() => {});
    }

    const canCache = snapshot.meta.mode === 'live'
      && snapshot.meta.gatewayFreshness === 'fresh'
      && !snapshot.meta.observablePending;
    if (generation === runtimeInventoryGeneration && canCache) {
      runtimeInventoryCache.set(cacheKey, {
        snapshot,
        cachedAt: Date.now(),
        idle: !inventoryHasOwnedOrLiveSession(snapshot),
      });
    }
    return snapshot;
  })();

  runtimeInventoryInflight.set(cacheKey, { generation, promise });
  promise.finally(() => {
    const current = runtimeInventoryInflight.get(cacheKey);
    if (current?.promise === promise) {
      runtimeInventoryInflight.delete(cacheKey);
    }
  });

  // Same timeout race on the cold path: slow discovery falls back to cached
  // data (or an empty shell on first boot) while the real build completes
  // in the background and updates the cache for the next request.
  return Promise.race([
    promise,
    new Promise<FleetSnapshot>((resolve) => {
      setTimeout(() => resolve(cached?.snapshot ?? buildEmptyInventorySnapshot()), RUNTIME_INVENTORY_BUILD_TIMEOUT_MS);
    }),
  ]);
}
