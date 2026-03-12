import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { demoFleet } from '@/lib/demo/fleet';
import { getCodexDiscoveredFleetAdditions } from '@/lib/codex/sessions';
import type {
  AgentStatus,
  AgentSummary,
  EventSeverity,
  FleetSnapshot,
  SquadStatus,
  SquadSummary,
} from '@/lib/fleet/types';

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

export async function getOpenClawFleetSnapshot(): Promise<FleetSnapshot> {
  try {
    const { stdout } = await execFileAsync('openclaw', ['status', '--json'], {
      cwd: WORKSPACE_ROOT,
      maxBuffer: 4 * 1024 * 1024,
    });

    const parsed = JSON.parse(extractJsonPayload(stdout)) as OpenClawStatusPayload;
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
          usedPercent: session.percentUsed ?? 0,
          trend: deriveTrend(session.percentUsed, ageMs),
        },
        alerts,
        sessionId: session.sessionId,
        sessionKind: session.kind ?? 'direct',
        surfaceLabel,
        isCurrentSession,
        runtimeSurface: buildOpenClawRuntimeSurface(name, session, workspace, branch, surfaceLabel),
        tokenUsage: {
          totalTokens: session.totalTokens,
          remainingTokens: session.remainingTokens,
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

    const codexDiscovery = await getCodexDiscoveredFleetAdditions();
    const allAgents = [...agents, ...codexDiscovery.agents];
    const allSquads = [...openClawSquads, ...codexDiscovery.squads];
    const allEvents = [...openClawEvents, ...codexDiscovery.events];

    return {
      generatedAt: new Date().toISOString(),
      meta: {
        mode: 'live',
        sourceLabel: codexDiscovery.sourceLabel
          ? `runtime inventory • openclaw status --json + ${codexDiscovery.sourceLabel}`
          : 'runtime inventory • openclaw status --json',
        gatewayLabel: parsed.gateway?.reachable
          ? `OpenClaw ${parsed.gateway?.self?.version ?? 'unknown'} • ${parsed.gateway?.mode ?? 'local'} gateway`
          : 'Gateway unreachable',
        primarySessionKey: primarySession.key,
        mirrorMode: 'current-session-first',
        note: [
          primarySession.key === 'agent:main:main'
            ? 'Mirroring this live Q ↔ Mister session first. New sessions should only appear when you explicitly spawn them.'
            : 'Mirroring existing OpenClaw sessions first. New sessions should only appear when you explicitly spawn them.',
          codexDiscovery.note,
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
        ...codexDiscovery.artifacts,
      ],
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown bridge error';
    return buildDemoFallback(reason);
  }
}
