import type {
  AgentSummary,
  RuntimeSurfaceLifecycle,
  RuntimeSurfaceSummary,
} from '@/lib/fleet/types';

import {
  ACTIVE_WINDOW_MS,
  RECENT_WINDOW_MS,
  RUNS_DIR,
  compactText,
  isPidAlive,
  lifecycleAvailabilityLabel,
  shortHome,
} from './helpers';
import type {
  OwnedChildExitOutcome,
  OwnedReviewDisposition,
  OwnedRuntimeAdapter,
  OwnedSessionRecord,
} from './types';
import { executionCarrierRuntimeLabel } from '@/lib/runtimes/shared/execution-carrier';

export interface OwnedLifecycleContext {
  adapter: OwnedRuntimeAdapter;
  runtimeId: string;
}

export function latestFinishedRun(session: OwnedSessionRecord) {
  return [...session.recentRuns]
    .filter((run) => run.outcome !== 'running')
    .sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt))[0];
}

export function latestRun(session: OwnedSessionRecord) {
  return [...session.recentRuns].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

export function deriveLifecycle(
  context: OwnedLifecycleContext,
  session: OwnedSessionRecord,
  activeRunOverride?: boolean,
): RuntimeSurfaceLifecycle {
  const { adapter } = context;
  const activeRun = activeRunOverride === true
    ? session.activeRun
    : activeRunOverride === false
      ? undefined
      : (session.activeRun && isPidAlive(session.activeRun.pid) ? session.activeRun : undefined);
  const latest = latestFinishedRun(session);

  if (activeRun) {
    return {
      availability: 'running',
      lastOutcome: latest?.outcome === 'finished' || latest?.outcome === 'interrupted' || latest?.outcome === 'failed'
        ? latest.outcome
        : undefined,
      lastRunMode: activeRun.mode,
      lastRunStartedAt: activeRun.startedAt,
      lastRunFinishedAt: latest?.finishedAt,
      summary: 'Active owned run in flight.',
    };
  }

  if (!session.threadId) {
    return {
      availability: 'awaiting-thread',
      lastOutcome: latest?.outcome === 'finished' || latest?.outcome === 'interrupted' || latest?.outcome === 'failed'
        ? latest.outcome
        : undefined,
      lastRunMode: latest?.mode,
      lastRunStartedAt: latest?.startedAt,
      lastRunFinishedAt: latest?.finishedAt,
      summary: `Waiting for the first persistent ${adapter.squadShortName} thread id before resume is available.`,
    };
  }

  return {
    availability: 'ready-for-resume',
    lastOutcome: latest?.outcome === 'finished' || latest?.outcome === 'interrupted' || latest?.outcome === 'failed'
      ? latest.outcome
      : undefined,
    lastRunMode: latest?.mode,
    lastRunStartedAt: latest?.startedAt,
    lastRunFinishedAt: latest?.finishedAt,
    summary: latest?.outcome === 'interrupted'
      ? 'Previous run was interrupted. This owned session is ready for the next bounded input.'
      : latest?.outcome === 'failed'
        ? 'Previous run failed. This owned session is ready for a corrective follow-up.'
        : 'Owned session is idle between runs and ready for the next bounded input.',
  };
}

export function reviewDisposition(session: OwnedSessionRecord): OwnedReviewDisposition {
  return session.reviewDisposition ?? 'watching';
}

export function buildRuntimeSurface(
  context: OwnedLifecycleContext,
  session: OwnedSessionRecord,
  running: boolean,
): RuntimeSurfaceSummary {
  const { adapter, runtimeId } = context;
  const runtimeLabel = executionCarrierRuntimeLabel(adapter.squadShortName, session.runtimeConfig);
  const lifecycle = deriveLifecycle(context, session);
  const lastOutcomeLabel = lifecycle.lastOutcome ? ` • last ${lifecycle.lastOutcome}` : '';

  return {
    id: session.surfaceId,
    runtime: runtimeId,
    kind: 'runtime-session',
    ownership: 'owned',
    title: session.title,
    cwd: shortHome(session.repoPath),
    branch: session.branch,
    sourceLabel: running
      ? `IDE-owned ${runtimeLabel} registry • active pid ${session.activeRun?.pid ?? 'unknown'}${lastOutcomeLabel}`
      : `IDE-owned ${runtimeLabel} registry • ${lifecycleAvailabilityLabel(lifecycle.availability)}${lastOutcomeLabel}`,
    tailSourceLabel: `${shortHome(session.sessionDir)}/${RUNS_DIR}/*.jsonl`,
    capabilities: {
      attach: true,
      readTail: true,
      sendInput: lifecycle.availability === 'ready-for-resume',
      interrupt: lifecycle.availability === 'running',
      resize: false,
      diffContext: Boolean(session.branch || session.repoSlug),
      reviewContext: Boolean(session.branch || session.repoSlug),
    },
    lifecycle,
    reviewContext: {
      repoSlug: session.repoSlug,
      branch: session.branch,
      head: session.head,
    },
  };
}

export function deriveOwnedStatus(
  context: OwnedLifecycleContext,
  session: OwnedSessionRecord,
): AgentSummary['status'] {
  const lifecycle = deriveLifecycle(context, session);
  if (lifecycle.availability === 'running') return 'running';
  if (lifecycle.lastOutcome === 'failed') return 'failed';
  if (lifecycle.availability === 'awaiting-thread') return 'waiting';
  if (lifecycle.lastOutcome === 'interrupted') return 'waiting';
  if (lifecycle.availability === 'ready-for-resume') return 'reviewing';

  const latest = latestRun(session);
  if (!latest) return 'idle';
  const ageMs = Math.max(0, Date.now() - new Date(latest.finishedAt ?? latest.startedAt).getTime());
  if (ageMs < ACTIVE_WINDOW_MS) return 'reviewing';
  if (ageMs < RECENT_WINDOW_MS) return 'reviewing';
  return 'idle';
}

export function buildCurrentTask(
  context: OwnedLifecycleContext,
  session: OwnedSessionRecord,
  running: boolean,
) {
  const { adapter } = context;
  const runtimeLabel = executionCarrierRuntimeLabel(adapter.squadShortName, session.runtimeConfig);
  const lifecycle = deriveLifecycle(context, session);
  if (running) {
    return `IDE-launched ${runtimeLabel} run active. ${session.latestSummary}`;
  }
  if (lifecycle.availability === 'awaiting-thread') {
    return `IDE-owned ${runtimeLabel} session launched and waiting for its first thread id. ${session.latestSummary}`;
  }
  if (reviewDisposition(session) === 'resolved') {
    return `Operator marked this owned result resolved. Keep watching only if new evidence appears. ${session.latestSummary}`;
  }
  if (lifecycle.lastOutcome === 'interrupted') {
    return `IDE-owned ${runtimeLabel} session is ready for resume after an interrupted run. ${session.latestSummary}`;
  }
  if (lifecycle.lastOutcome === 'failed') {
    return `IDE-owned ${runtimeLabel} session is ready for a corrective follow-up after a failed run. ${session.latestSummary}`;
  }
  if (session.threadId) {
    return `IDE-owned ${runtimeLabel} session ready for the next input via resume. ${session.latestSummary}`;
  }
  return `IDE-owned ${runtimeLabel} session is idle. ${session.latestSummary}`;
}

export function formatChildExit(outcome: OwnedChildExitOutcome | undefined) {
  if (!outcome) return '';
  const signal = outcome.signal ? ` signal ${outcome.signal}` : '';
  const code = outcome.code === null ? '' : ` code ${outcome.code}`;
  const stderrTail = outcome.stderrTail ? ` stderrTail=${compactText(outcome.stderrTail, 180)}` : '';
  return ` • child ${outcome.classification}${code}${signal}${stderrTail}`;
}
