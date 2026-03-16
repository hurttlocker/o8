import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { demoFleet } from '@/lib/demo/fleet';
import { getOwnedCodexFleetAdditions } from '@/lib/codex/owned';
import { getCodexDiscoveredFleetAdditions } from '@/lib/codex/sessions';
import { claudeCodeRuntime } from '@/lib/runtimes/claude-code';
import type {
  AgentStatus,
  AgentSummary,
  EventSeverity,
  FleetSnapshot,
  SquadStatus,
  SquadSummary,
} from '@/lib/fleet/types';
import type { RuntimeSession } from '@/lib/runtimes/types';

const execFileAsync = promisify(execFile);
const WORKSPACE_ROOT = process.env.CORTEX_IDE_WORKSPACE_ROOT || '/Users/marquisehurtt/clawd';

type OpenClawRecentSession = {
  agentId?: string;
  key: string;
  kind?: string;
  sessionId: string;
  updatedAt: number;
  age?: number;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  totalTokens?: number | null;
  totalTokensFresh?: boolean;
  remainingTokens?: number | null;
  percentUsed?: number | null;
  model?: string;
  contextTokens?: number;
};

type OpenClawAgentMeta = {
  id: string;
  name?: string;
  workspaceDir?: string;
  lastActiveAgeMs?: number;
};

type OpenClawStatusPayload = {
  gateway?: {
    reachable?: boolean;
    mode?: string;
    self?: {
      version?: string;
      platform?: string;
    };
  };
  sessions?: {
    recent?: OpenClawRecentSession[];
  };
  agents?: {
    agents?: OpenClawAgentMeta[];
  };
};

function extractJsonPayload(raw: string) {
  const firstBrace = raw.indexOf('{');
  if (firstBrace === -1) {
    throw new Error('OpenClaw status did not return JSON output.');
  }

  return raw.slice(firstBrace);
}

function relativeAge(ageMs?: number) {
  if (!ageMs || ageMs < 0) return 'just now';

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (ageMs < minute) return 'just now';
  if (ageMs < hour) return `${Math.max(1, Math.round(ageMs / minute))}m ago`;
  if (ageMs < day) return `${Math.max(1, Math.round(ageMs / hour))}h ago`;
  return `${Math.max(1, Math.round(ageMs / day))}d ago`;
}

function shortenPath(path?: string) {
  if (!path) return 'unknown';
  return path.replace('/Users/marquisehurtt/', '~/');
}

function isDuplicateRunSurface(key: string) {
  return key.includes(':run:');
}

function deriveSurfaceLabel(session: OpenClawRecentSession, isCurrentSession: boolean) {
  if (isCurrentSession) return 'Current Q chat';
  if (session.key.includes(':cron:')) return 'Cron / automation';
  if (session.key.includes(':telegram:group:')) return 'Telegram group';
  if (session.key.includes(':discord:channel:')) return 'Discord channel';
  if (session.kind === 'group') return 'Group surface';
  return 'Direct session';
}

function deriveSessionName(
  session: OpenClawRecentSession,
  agentMeta: Record<string, OpenClawAgentMeta>,
  isCurrentSession: boolean,
) {
  const agentName = agentMeta[session.agentId ?? '']?.name ?? session.agentId ?? 'OpenClaw';

  if (isCurrentSession) return 'This chat';
  if (session.key.includes(':cron:')) return `${agentName} automation`;
  if (session.key.includes(':telegram:group:')) return `${agentName} Telegram group`;
  if (session.key.includes(':discord:channel:')) return `${agentName} Discord channel`;
  if (session.key === `agent:${session.agentId}:main`) return `${agentName} direct`;
  return `${agentName} session`;
}

function deriveCurrentTask(session: OpenClawRecentSession, surfaceLabel: string, isCurrentSession: boolean) {
  if (isCurrentSession) {
    return 'Mirroring the live Q ↔ Mister conversation, not spawning a fresh session.';
  }
  if (session.key.includes(':cron:')) {
    return 'Recent automation surface; useful for visibility, not the primary operator lane.';
  }
  if (surfaceLabel === 'Telegram group' || surfaceLabel === 'Discord channel') {
    return 'Shared channel surface attached to the same OpenClaw runtime.';
  }
  return 'Existing OpenClaw session mirrored into the control plane.';
}

function deriveStatus(session: OpenClawRecentSession): AgentStatus {
  const ageMs = session.age ?? Math.max(0, Date.now() - session.updatedAt);

  if (session.abortedLastRun) return 'blocked';
  if (session.key.includes(':cron:')) return ageMs < 30 * 60_000 ? 'running' : 'waiting';
  if (ageMs < 5 * 60_000) return 'running';
  if (ageMs < 2 * 60 * 60_000) return 'reviewing';
  return 'idle';
}

function deriveTrend(percentUsed?: number | null, ageMs?: number) {
  if ((percentUsed ?? 0) >= 60) return 'rising' as const;
  if ((ageMs ?? 0) > 2 * 60 * 60_000) return 'falling' as const;
  return 'stable' as const;
}

function buildOpenClawRuntimeSurface(title: string, session: OpenClawRecentSession, workspace: string, branch: string, surfaceLabel: string) {
  return {
    id: session.key,
    runtime: 'openclaw',
    kind: 'chat-session' as const,
    ownership: 'provider' as const,
    title,
    cwd: workspace,
    branch,
    sourceLabel: `OpenClaw live gateway • ${surfaceLabel}`,
    tailSourceLabel: 'chat.history',
    capabilities: {
      attach: true,
      readTail: true,
      sendInput: true,
      interrupt: true,
      resize: false,
      diffContext: true,
      reviewContext: true,
    },
    reviewContext: {
      branch,
      repoSlug: 'hurttlocker/cortex-ide',
    },
  };
}

function deriveEventSeverity(status: AgentStatus, isCurrentSession: boolean): EventSeverity {
  if (status === 'blocked' || status === 'failed') return 'critical';
  if (isCurrentSession) return 'success';
  if (status === 'running' || status === 'reviewing') return 'info';
  return 'warning';
}

function deriveSquadStatus(blockers: number, alerts: number, lastActiveAgeMs?: number): SquadStatus {
  if (blockers > 0) return 'blocked';
  if (alerts > 0) return 'watching';
  if ((lastActiveAgeMs ?? Infinity) < 2 * 60 * 60_000) return 'healthy';
  return 'watching';
}

function buildDemoFallback(reason: string): FleetSnapshot {
  return {
    ...demoFleet,
    generatedAt: new Date().toISOString(),
    meta: {
      mode: 'demo',
      sourceLabel: 'Demo runtime inventory snapshot',
      mirrorMode: 'demo-only',
      note: `Live runtime inventory unavailable: ${reason}`,
    },
  };
}

function shortenHomePath(filePath: string): string {
  const home = process.env.HOME ?? '/Users/unknown';
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function mapClaudeCodeSessionToAgent(session: RuntimeSession): AgentSummary {
  const ageMs = Date.now() - session.lastActivityAt.getTime();
  return {
    id: session.sessionKey,
    name: session.displayName,
    squadId: 'squad-claude-code',
    runtime: 'claude-code',
    model: session.model ?? 'claude',
    status: session.status === 'running' ? 'running'
      : session.status === 'reviewing' ? 'reviewing'
      : 'idle',
    currentTask: session.initialTask ?? 'Claude Code session',
    workspace: shortenHomePath(session.cwd),
    branch: session.branch ?? 'unknown',
    sessionKey: session.sessionKey,
    approvalStatus: 'none',
    lastEventAt: relativeAge(ageMs),
    context: { usedPercent: 0, trend: 'stable' },
    alerts: 0,
    sessionId: session.sessionKey.replace('claude-code:', ''),
    sessionKind: 'terminal',
    surfaceLabel: 'Claude Code terminal',
    runtimeSurface: {
      id: session.sessionKey,
      runtime: 'claude-code',
      kind: 'terminal-session',
      ownership: session.ownership,
      title: session.displayName,
      cwd: shortenHomePath(session.cwd),
      branch: session.branch,
      sourceLabel: 'Local Claude Code discovery • ~/.claude/projects/',
      tailSourceLabel: '~/.claude/projects/*.jsonl',
      capabilities: {
        attach: true,
        readTail: true,
        sendInput: session.sessionCapabilities.canSendInput,
        interrupt: session.sessionCapabilities.canInterrupt,
        resize: false,
        diffContext: session.sessionCapabilities.canReviewDiffs,
        reviewContext: true,
      },
      lifecycle: session.lifecycle ? {
        availability: session.lifecycle.availability,
        lastOutcome: session.lifecycle.lastOutcome,
        lastRunMode: session.lifecycle.lastRunMode,
        lastRunStartedAt: session.lifecycle.lastRunStartedAt,
        lastRunFinishedAt: session.lifecycle.lastRunFinishedAt,
        summary: session.lifecycle.summary,
      } : undefined,
      reviewContext: {
        repoSlug: session.repoSlug,
        branch: session.branch,
        head: session.headSha,
      },
    },
  };
}

async function discoverClaudeCodeSessions(): Promise<{
  agents: AgentSummary[];
  squads: SquadSummary[];
  events: Array<{ id: string; agentId: string; squadId: string; severity: EventSeverity; title: string; detail: string; timestamp: string }>;
  sourceLabel: string;
  note: string;
}> {
  try {
    const sessions = await claudeCodeRuntime.discoverSessions();
    if (sessions.length === 0) {
      return { agents: [], squads: [], events: [], sourceLabel: '', note: '' };
    }

    const agents = sessions.map(mapClaudeCodeSessionToAgent);
    const squads: SquadSummary[] = [{
      id: 'squad-claude-code',
      name: 'Claude Code',
      status: agents.some((a) => a.status === 'running') ? 'healthy' : 'watching',
      throughputLabel: `${agents.length} local session${agents.length === 1 ? '' : 's'}`,
      blockers: 0,
      alerts: 0,
      liveSessions: agents.length,
      members: agents.map((a) => a.id),
    }];

    const events = agents.slice(0, 3).map((agent) => ({
      id: `evt-cc-${agent.id}`,
      agentId: agent.id,
      squadId: agent.squadId,
      severity: 'info' as EventSeverity,
      title: `${agent.name} • Claude Code`,
      detail: `${agent.currentTask?.slice(0, 120) ?? ''} • ${agent.lastEventAt}`,
      timestamp: agent.lastEventAt,
    }));

    return {
      agents,
      squads,
      events,
      sourceLabel: `Claude Code discovery (${agents.length} session${agents.length === 1 ? '' : 's'})`,
      note: `${agents.length} Claude Code session${agents.length === 1 ? '' : 's'} discovered from ~/.claude/projects/`,
    };
  } catch (err) {
    console.error('[fleet] Claude Code discovery failed:', err);
    return { agents: [], squads: [], events: [], sourceLabel: '', note: '' };
  }
}

export async function getOpenClawFleetSnapshot(): Promise<FleetSnapshot> {
  try {
    // Use gateway REST API (<50ms) with CLI fallback (30-40s)
    const { getGatewayStatus } = await import('@/lib/openclaw/gateway-client');
    const parsed = await getGatewayStatus() as unknown as OpenClawStatusPayload;
    const recent = (parsed.sessions?.recent ?? [])
      .filter((session) => !isDuplicateRunSurface(session.key))
      .slice(0, 10);

    if (!recent.length) {
      return buildDemoFallback('OpenClaw returned no recent mirrored sessions.');
    }

    const agentMeta = Object.fromEntries(
      (parsed.agents?.agents ?? []).map((agent) => [agent.id, agent]),
    ) as Record<string, OpenClawAgentMeta>;

    const primarySession = recent.find((session) => session.key === 'agent:main:main') ?? recent[0];

    const agents: AgentSummary[] = recent.map((session) => {
      const ageMs = session.age ?? Math.max(0, Date.now() - session.updatedAt);
      const isCurrentSession = session.key === primarySession.key && session.key === 'agent:main:main';
      const surfaceLabel = deriveSurfaceLabel(session, isCurrentSession);
      const status = deriveStatus(session);
      const alerts = Number(Boolean(session.abortedLastRun)) + Number((session.percentUsed ?? 0) >= 70);
      const workspace = shortenPath(agentMeta[session.agentId ?? '']?.workspaceDir);
      const branch = `surface/${surfaceLabel.toLowerCase().replace(/\s+/g, '-')}`;
      const name = deriveSessionName(session, agentMeta, isCurrentSession);

      return {
        id: session.key,
        name,
        squadId: `squad-${session.agentId ?? 'openclaw'}`,
        runtime: 'openclaw',
        model: session.model ?? 'unknown',
        status,
        currentTask: deriveCurrentTask(session, surfaceLabel, isCurrentSession),
        workspace,
        branch,
        sessionKey: session.key,
        approvalStatus: 'none',
        lastEventAt: relativeAge(ageMs),
        context: {
          usedPercent: session.percentUsed
            ?? (session.contextTokens && session.totalTokens
              ? Math.min(100, Math.round((session.totalTokens / session.contextTokens) * 100))
              : 0),
          trend: deriveTrend(
            session.percentUsed
              ?? (session.contextTokens && session.totalTokens
                ? Math.round((session.totalTokens / session.contextTokens) * 100)
                : null),
            ageMs,
          ),
        },
        alerts,
        sessionId: session.sessionId,
        sessionKind: session.kind ?? 'direct',
        surfaceLabel,
        isCurrentSession,
        runtimeSurface: buildOpenClawRuntimeSurface(name, session, workspace, branch, surfaceLabel),
        tokenUsage: {
          totalTokens: session.totalTokens,
          remainingTokens: session.remainingTokens
            ?? (session.contextTokens && session.totalTokens
              ? Math.max(0, session.contextTokens - session.totalTokens)
              : undefined),
          fresh: session.totalTokensFresh,
        },
      };
    });

    const openClawSquads: SquadSummary[] = (parsed.agents?.agents ?? [])
      .map((agent) => {
        const members = agents.filter((item) => item.squadId === `squad-${agent.id}`).map((item) => item.id);
        if (!members.length) return null;

        const blockers = agents.filter(
          (item) => item.squadId === `squad-${agent.id}` && item.status === 'blocked',
        ).length;
        const alerts = agents
          .filter((item) => item.squadId === `squad-${agent.id}`)
          .reduce((sum, item) => sum + item.alerts, 0);

        return {
          id: `squad-${agent.id}`,
          name: agent.name ?? agent.id,
          status: deriveSquadStatus(blockers, alerts, agent.lastActiveAgeMs),
          throughputLabel: `${members.length} visible surface${members.length === 1 ? '' : 's'}`,
          blockers,
          alerts,
          liveSessions: members.length,
          members,
        } satisfies SquadSummary;
      })
      .filter((item): item is SquadSummary => Boolean(item));

    const openClawEvents = agents.slice(0, 6).map((agent) => ({
      id: `evt-${agent.id}`,
      agentId: agent.id,
      squadId: agent.squadId,
      severity: deriveEventSeverity(agent.status, Boolean(agent.isCurrentSession)),
      title: `${agent.name} • ${agent.surfaceLabel}`,
      detail: `${agent.currentTask} ${agent.tokenUsage?.totalTokens ? `• ${Intl.NumberFormat('en-US', { notation: 'compact' }).format(agent.tokenUsage.totalTokens)} tokens` : ''}`.trim(),
      timestamp: agent.lastEventAt,
    }));

    const [ownedCodex, codexDiscovery, claudeCodeSessions] = await Promise.all([
      getOwnedCodexFleetAdditions(),
      getCodexDiscoveredFleetAdditions(),
      discoverClaudeCodeSessions(),
    ]);

    const ownedThreadIds = new Set(ownedCodex.ownedThreadIds);
    // Only show discovered codex sessions that have a live process (active PID)
    // or are IDE-owned. Filter out stale SQLite session records.
    const filteredDiscoveredAgents = codexDiscovery.agents.filter((agent) => {
      if (ownedThreadIds.has(agent.sessionId ?? '')) return false; // handled by owned
      // Only include if the agent has an active process (running status from live PID)
      return agent.status === 'running';
    });
    const filteredDiscoveredAgentIds = new Set(filteredDiscoveredAgents.map((agent) => agent.id));
    const filteredDiscoveredEvents = codexDiscovery.events.filter((event) => filteredDiscoveredAgentIds.has(event.agentId ?? ''));
    const filteredDiscoveredArtifacts = codexDiscovery.artifacts.filter(
      (artifact) => !artifact.agentId || filteredDiscoveredAgentIds.has(artifact.agentId),
    );
    const filteredDiscoveredSquads = filteredDiscoveredAgents.length
      ? [{
          id: 'squad-codex-local',
          name: 'Codex Local',
          status: filteredDiscoveredAgents.some((agent) => agent.status === 'running') ? 'healthy' : 'watching',
          throughputLabel: `${filteredDiscoveredAgents.length} local terminal surface${filteredDiscoveredAgents.length === 1 ? '' : 's'}`,
          blockers: 0,
          alerts: filteredDiscoveredAgents.reduce((sum, agent) => sum + agent.alerts, 0),
          liveSessions: filteredDiscoveredAgents.length,
          members: filteredDiscoveredAgents.map((agent) => agent.id),
        } satisfies SquadSummary]
      : [];

    const allAgents = [...agents, ...ownedCodex.agents, ...filteredDiscoveredAgents, ...claudeCodeSessions.agents];
    const allSquads = [...openClawSquads, ...ownedCodex.squads, ...filteredDiscoveredSquads, ...claudeCodeSessions.squads];
    const allEvents = [...openClawEvents, ...ownedCodex.events, ...filteredDiscoveredEvents, ...claudeCodeSessions.events];

    return {
      generatedAt: new Date().toISOString(),
      meta: {
        mode: 'live',
        sourceLabel: [
          'runtime inventory • openclaw status --json',
          ownedCodex.sourceLabel,
          codexDiscovery.sourceLabel,
          claudeCodeSessions.sourceLabel,
        ].filter(Boolean).join(' + '),
        gatewayLabel: parsed.gateway?.reachable
          ? `OpenClaw ${parsed.gateway?.self?.version ?? 'unknown'} • ${parsed.gateway?.mode ?? 'local'} gateway`
          : 'Gateway unreachable',
        primarySessionKey: primarySession.key,
        mirrorMode: 'current-session-first',
        note: [
          primarySession.key === 'agent:main:main'
            ? 'Mirroring this live Q ↔ Mister session first. New sessions should only appear when you explicitly spawn them.'
            : 'Mirroring existing OpenClaw sessions first. New sessions should only appear when you explicitly spawn them.',
          ownedCodex.note,
          codexDiscovery.note,
          claudeCodeSessions.note,
        ].filter(Boolean).join(' '),
      },
      squads: allSquads,
      agents: allAgents,
      events: allEvents,
      artifacts: [
        {
          kind: 'run_log',
          title: 'Live OpenClaw session bridge',
          state: 'approved',
          agentId: primarySession.key,
          detail: 'Readable session-log lane for the currently mirrored OpenClaw surface.',
        },
        {
          kind: 'doc',
          title: 'Current session mirrored first',
          state: 'approved',
          agentId: primarySession.key,
          detail: 'Guardrail that keeps the UI from silently spawning a ghost session.',
        },
        {
          kind: 'pull_request',
          title: 'PR #22 — live OpenClaw bridge lane',
          href: 'https://github.com/hurttlocker/cortex-ide/pull/22',
          state: 'reviewing',
          detail: 'Active code lane that turned the shell into a truthful live bridge.',
        },
        ...ownedCodex.artifacts,
        ...filteredDiscoveredArtifacts,
      ],
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown bridge error';
    return buildDemoFallback(reason);
  }
}
