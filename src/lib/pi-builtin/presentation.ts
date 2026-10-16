import os from 'node:os';
import { readFile } from 'node:fs/promises';

import type {
  AgentSummary,
  EventItem,
  RuntimeReviewPacket,
  RuntimeSurfaceSummary,
  SquadSummary,
} from '@/lib/fleet/types';
import { getRuntimeRepoReview } from '@/lib/git/runtime-review';
import { compactText, formatClock } from '@/lib/runtimes/shared/owned-session/helpers';
import type {
  OwnedFleetAdditions,
  OwnedReviewDisposition,
  OwnedTailEntry,
  OwnedTailGroup,
} from '@/lib/runtimes/shared/owned-session/types';
import { parsePiWorkerRunLog } from './run-log';
import { PI_BUILTIN_RUNTIME_ID, type PiWorkerSessionRecord } from './types';

const SQUAD_ID = `squad-${PI_BUILTIN_RUNTIME_ID}-owned`;

export function buildPiWorkerSurface(session: PiWorkerSessionRecord): RuntimeSurfaceSummary {
  const running = session.activeRun?.outcome === 'running';
  const latest = session.activeRun ?? session.recentRuns[0];
  return {
    id: session.surfaceId,
    runtime: PI_BUILTIN_RUNTIME_ID,
    kind: 'runtime-session',
    ownership: 'owned',
    title: session.title,
    cwd: session.cwd.replace(os.homedir(), '~'),
    branch: session.branch,
    sourceLabel: running
      ? `Pi (built-in) • pid ${session.activeRun?.pid ?? 'starting'}`
      : 'Pi (built-in) • managed route',
    tailSourceLabel: `${session.sessionDir}/runs/*.jsonl`,
    capabilities: {
      attach: true,
      readTail: true,
      sendInput: !running && !session.detachedAt,
      interrupt: running,
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
        ? 'A Pi turn is running in this workspace.'
        : 'The next message starts Pi again on the same session.',
    },
    reviewContext: { repoSlug: session.repoSlug, branch: session.branch, head: session.head },
  };
}

export async function piWorkerTail(session: PiWorkerSessionRecord, limit?: number) {
  const entries: OwnedTailEntry[] = [];
  const groups: OwnedTailGroup[] = [];
  for (const run of [...session.recentRuns].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const runEntries = parsePiWorkerRunLog(await readFile(run.stdoutPath, 'utf8').catch(() => ''), run);
    entries.push(...runEntries);
    groups.push({
      id: run.id,
      title: `${run.mode === 'launch' ? 'Pi launch turn' : 'Pi follow-up turn'} • ${run.outcome}`,
      mode: run.mode,
      outcome: run.outcome,
      prompt: compactText(run.prompt, 8_000),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      startedAtLabel: formatClock(run.startedAt),
      finishedAtLabel: formatClock(run.finishedAt),
      summary: runEntries.at(-1)?.text ?? session.latestSummary,
      entries: runEntries,
    });
  }
  const retainedEntries = Math.min(Math.max(Math.floor(limit ?? 24), 1), 200);
  const retainedGroups = limit === undefined ? 8 : Math.min(Math.max(Math.floor(limit), 8), 200);
  return {
    surface: buildPiWorkerSurface(session),
    entries: entries.slice(-retainedEntries),
    groups: groups.slice(-retainedGroups),
  };
}

export function piWorkerFleet(sessions: PiWorkerSessionRecord[]): OwnedFleetAdditions {
  const agents: AgentSummary[] = sessions.map((session) => {
    const running = session.activeRun?.outcome === 'running';
    const failed = session.recentRuns[0]?.outcome === 'failed';
    return {
      id: session.surfaceId,
      name: session.title,
      squadId: SQUAD_ID,
      runtime: PI_BUILTIN_RUNTIME_ID,
      model: session.model,
      status: running ? 'running' : failed ? 'failed' : 'reviewing',
      currentTask: session.latestSummary,
      workspace: session.cwd,
      branch: session.branch ?? '',
      sessionKey: session.surfaceId,
      sessionId: session.threadId ?? session.surfaceId,
      approvalStatus: 'none',
      lastEventAt: session.updatedAt,
      context: { usedPercent: 0, trend: running ? 'rising' : 'stable' },
      alerts: failed ? 1 : 0,
      runtimeSurface: buildPiWorkerSurface(session),
    } satisfies AgentSummary;
  });
  const squads: SquadSummary[] = agents.length ? [{
    id: SQUAD_ID,
    name: 'Pi (built-in) Owned',
    status: agents.some((agent) => agent.status === 'running') ? 'watching' : 'healthy',
    throughputLabel: `${agents.length} Pi session${agents.length === 1 ? '' : 's'}`,
    blockers: 0,
    alerts: agents.reduce((sum, agent) => sum + agent.alerts, 0),
    liveSessions: agents.filter((agent) => agent.status === 'running').length,
    members: agents.map((agent) => agent.id),
  }] : [];
  const events: EventItem[] = agents.slice(0, 4).map((agent) => ({
    id: `evt-${agent.id}`,
    agentId: agent.id,
    squadId: SQUAD_ID,
    severity: agent.status === 'failed' ? 'critical' : agent.status === 'running' ? 'info' : 'success',
    title: `${agent.name} • Pi (built-in)`,
    detail: agent.currentTask,
    timestamp: agent.lastEventAt,
  }));
  return {
    agents,
    squads,
    events,
    artifacts: [],
    ownedThreadIds: sessions.map((session) => session.threadId ?? '').filter(Boolean),
    sourceLabel: 'Pi (built-in) sessions',
  };
}

export async function piWorkerReviewPacket(session: PiWorkerSessionRecord): Promise<RuntimeReviewPacket> {
  const review = await getRuntimeRepoReview(session.cwd);
  const latest = session.recentRuns[0];
  return {
    surfaceId: session.surfaceId,
    runtime: PI_BUILTIN_RUNTIME_ID,
    title: session.title,
    summary: session.latestSummary,
    repoPath: session.cwd.replace(os.homedir(), '~'),
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
    notes: [`Model: ${session.model} on the o8 managed route`],
  };
}

export function reviewDispositionNote(disposition: OwnedReviewDisposition): string {
  return disposition === 'resolved' ? 'Marked Pi result resolved.' : 'Watching Pi result.';
}
