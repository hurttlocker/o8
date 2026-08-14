import os from 'node:os';
import { readFile } from 'node:fs/promises';

import type {
  AgentSummary,
  EventItem,
  ReviewArtifact,
  RuntimeReviewPacket,
  RuntimeSurfaceSummary,
  SquadSummary,
} from '@/lib/fleet/types';
import { getRuntimeRepoReview } from '@/lib/git/runtime-review';
import {
  compactText,
  formatClock,
} from '@/lib/runtimes/shared/owned-session/helpers';
import type {
  OwnedFleetAdditions,
  OwnedTailEntry,
  OwnedTailGroup,
} from '@/lib/runtimes/shared/owned-session/types';
import type {
  OwnedAcpRuntimeAdapter,
  OwnedAcpSessionRecord,
} from './types';

function latestRun(session: OwnedAcpSessionRecord) {
  return session.activeRun ?? session.recentRuns[0];
}

export function buildOwnedAcpSurface(
  adapter: OwnedAcpRuntimeAdapter,
  session: OwnedAcpSessionRecord,
  processAlive: boolean,
): RuntimeSurfaceSummary {
  const running = session.activeRun?.outcome === 'running';
  const latest = latestRun(session);
  const canResume = !running && (
    processAlive
    || session.supportsResume === true
    || !session.remoteSessionId
  );
  return {
    id: session.surfaceId,
    runtime: adapter.runtimeId,
    kind: 'runtime-session',
    ownership: 'owned',
    title: session.title,
    cwd: session.repoPath.replace(os.homedir(), '~'),
    branch: session.branch,
    sourceLabel: running
      ? `${adapter.humanLabel} ACP • active pid ${session.activeRun?.pid ?? session.rpcPid ?? 'starting'}`
      : `${adapter.humanLabel} ACP • ${session.serverVersion ?? 'ready'}`,
    tailSourceLabel: `${session.sessionDir}/runs/*.jsonl`,
    capabilities: {
      attach: true,
      readTail: true,
      sendInput: canResume,
      interrupt: running || Boolean(session.rpcPid),
      resize: false,
      diffContext: Boolean(session.branch || session.repoSlug),
      reviewContext: Boolean(session.branch || session.repoSlug),
    },
    lifecycle: {
      availability: running ? 'running' : 'ready-for-resume',
      lastOutcome: latest?.outcome === 'running' ? undefined : latest?.outcome,
      lastRunMode: latest?.mode,
      lastRunStartedAt: latest?.startedAt,
      lastRunFinishedAt: latest?.finishedAt,
      summary: running
        ? `An ${adapter.squadShortName} turn is running over the owned ACP process.`
        : canResume
          ? processAlive
            ? 'The live ACP session is ready for a follow-up turn.'
            : 'The durable ACP session is ready to reconnect for a follow-up turn.'
          : 'This ACP agent cannot reconnect after its owning process exits.',
    },
    reviewContext: { repoSlug: session.repoSlug, branch: session.branch, head: session.head },
  };
}

async function tailForSession(
  adapter: OwnedAcpRuntimeAdapter,
  session: OwnedAcpSessionRecord,
  processAlive: boolean,
  limit?: number,
) {
  const entries: OwnedTailEntry[] = [];
  const groups: OwnedTailGroup[] = [];
  for (const run of [...session.recentRuns].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const raw = await readFile(run.stdoutPath, 'utf8').catch(() => '');
    const parsed = adapter.parseRunLog(raw, run);
    entries.push(...parsed.entries);
    groups.push({
      id: run.id,
      title: `${run.mode === 'launch' ? 'ACP launch turn' : 'ACP follow-up turn'} • ${run.outcome}`,
      mode: run.mode,
      outcome: run.outcome,
      prompt: compactText(run.prompt, 8_000),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      startedAtLabel: formatClock(run.startedAt),
      finishedAtLabel: formatClock(run.finishedAt),
      summary: parsed.entries.at(-1)?.text ?? session.latestSummary,
      entries: parsed.entries,
    });
  }
  const retainedEntries = Math.min(Math.max(Math.floor(limit ?? 24), 1), 200);
  const retainedGroups = limit === undefined ? 8 : Math.min(Math.max(Math.floor(limit), 8), 200);
  return {
    surface: buildOwnedAcpSurface(adapter, session, processAlive),
    entries: entries.slice(-retainedEntries),
    groups: groups.slice(-retainedGroups),
  };
}

export function createOwnedAcpPresentation(input: {
  adapter: OwnedAcpRuntimeAdapter;
  findSession(surfaceId: string, includeArchive?: boolean): Promise<OwnedAcpSessionRecord | null>;
  listSessions(): Promise<OwnedAcpSessionRecord[]>;
  saveSession(session: OwnedAcpSessionRecord): Promise<void>;
  processAlive(surfaceId: string): boolean;
}) {
  const { adapter } = input;
  const squadId = `squad-${adapter.runtimeId}-owned`;

  async function getRuntimeTail(surfaceId: string, limit?: number) {
    const session = await input.findSession(surfaceId, true);
    if (!session) throw new Error(`${adapter.humanLabel} session was not found.`);
    return tailForSession(adapter, session, input.processAlive(surfaceId), limit);
  }

  async function getFleetAdditions(): Promise<OwnedFleetAdditions> {
    const sessions = await input.listSessions();
    const agents: AgentSummary[] = sessions.map((session) => {
      const running = session.activeRun?.outcome === 'running';
      const surface = buildOwnedAcpSurface(adapter, session, input.processAlive(session.surfaceId));
      return {
        id: session.surfaceId,
        name: session.title,
        squadId,
        runtime: adapter.runtimeId,
        model: session.model ?? `${adapter.runtimeId} default`,
        status: running ? 'running' : session.recentRuns[0]?.outcome === 'failed' ? 'failed' : 'reviewing',
        currentTask: session.latestSummary,
        workspace: session.repoPath,
        branch: session.branch ?? '',
        sessionKey: session.surfaceId,
        sessionId: session.remoteSessionId ?? session.threadId ?? session.surfaceId,
        approvalStatus: 'none',
        lastEventAt: session.updatedAt,
        context: { usedPercent: 0, trend: running ? 'rising' : 'stable' },
        alerts: session.recentRuns[0]?.outcome === 'failed' ? 1 : 0,
        runtimeSurface: surface,
      } satisfies AgentSummary;
    });
    const squads: SquadSummary[] = agents.length ? [{
      id: squadId,
      name: `${adapter.squadShortName} Owned`,
      status: agents.some((agent) => agent.status === 'running') ? 'watching' : 'healthy',
      throughputLabel: `${agents.length} ACP session${agents.length === 1 ? '' : 's'}`,
      blockers: 0,
      alerts: agents.reduce((sum, agent) => sum + agent.alerts, 0),
      liveSessions: agents.filter((agent) => agent.status === 'running').length,
      members: agents.map((agent) => agent.id),
    }] : [];
    const events: EventItem[] = agents.slice(0, 4).map((agent) => ({
      id: `evt-${agent.id}`,
      agentId: agent.id,
      squadId,
      severity: agent.status === 'failed' ? 'critical' : agent.status === 'running' ? 'info' : 'success',
      title: `${agent.name} • ${adapter.squadShortName} ACP`,
      detail: agent.currentTask,
      timestamp: agent.lastEventAt,
    }));
    const artifacts: ReviewArtifact[] = agents.slice(0, 3).map((agent) => ({
      kind: 'run_log',
      title: `${agent.name} ACP tail`,
      state: agent.status === 'failed' ? 'new' : 'reviewing',
      agentId: agent.id,
      detail: `Readable ACP transcript from an owned ${adapter.squadShortName} session.`,
    }));
    return {
      agents,
      squads,
      events,
      artifacts,
      ownedThreadIds: sessions
        .map((session) => session.remoteSessionId ?? session.threadId ?? '')
        .filter(Boolean),
      sourceLabel: `${adapter.humanLabel} ACP sessions`,
    };
  }

  async function getReviewPacket(surfaceId: string): Promise<RuntimeReviewPacket> {
    const session = await input.findSession(surfaceId, false);
    if (!session) throw new Error(`${adapter.humanLabel} review packet was not found.`);
    const review = await getRuntimeRepoReview(session.repoPath);
    const latest = session.recentRuns[0];
    return {
      surfaceId,
      runtime: adapter.runtimeId,
      title: session.title,
      summary: session.latestSummary,
      repoPath: session.repoPath.replace(os.homedir(), '~'),
      repoSlug: session.repoSlug,
      branch: review.branch ?? session.branch,
      head: review.head ?? session.head,
      dirty: review.dirty,
      diffStat: review.diffStat,
      changedFiles: review.changedFiles,
      recentCommits: review.recentCommits,
      reviewDisposition: session.reviewDisposition ?? 'watching',
      reviewDispositionUpdatedAt: session.reviewDispositionUpdatedAt,
      lastRun: latest ? {
        id: latest.id,
        mode: latest.mode,
        outcome: latest.outcome,
        prompt: latest.prompt,
        startedAt: latest.startedAt,
        finishedAt: latest.finishedAt,
        startedAtLabel: formatClock(latest.startedAt),
        finishedAtLabel: formatClock(latest.finishedAt),
        assistantSummary: session.latestSummary,
        commands: [],
      } : undefined,
      nextActions: [],
      notes: [
        `ACP process: ${session.commandIdentity ?? adapter.binaryName}`,
        session.serverVersion ? `Runtime version: ${session.serverVersion}` : 'Runtime version has not been observed yet.',
      ],
    };
  }

  async function getTelemetrySources(surfaceId: string) {
    const session = await input.findSession(surfaceId, true);
    if (!session) return null;
    return {
      threadId: session.remoteSessionId ?? session.threadId,
      model: session.model,
      stdoutPaths: [...session.recentRuns].reverse().map((run) => run.stdoutPath),
    };
  }

  async function setReviewDisposition(surfaceId: string, disposition: 'watching' | 'resolved') {
    const session = await input.findSession(surfaceId, false);
    if (!session) throw new Error(`${adapter.humanLabel} session was not found.`);
    session.reviewDisposition = disposition;
    session.reviewDispositionUpdatedAt = new Date().toISOString();
    await input.saveSession(session);
    return {
      disposition,
      note: disposition === 'resolved'
        ? `Marked ${adapter.squadShortName} result resolved.`
        : `Watching ${adapter.squadShortName} result.`,
    };
  }

  return {
    getRuntimeTail,
    getFleetAdditions,
    getReviewPacket,
    getTelemetrySources,
    setReviewDisposition,
  };
}
