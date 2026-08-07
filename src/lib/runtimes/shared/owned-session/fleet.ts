import { signalBridgeTerminalSession } from '@/lib/runtime/pty-bridge';

import {
  archiveOwnedSessionDir,
} from './archive';
import {
  OWNED_STALE_WINDOW_MS,
  isOwnedRunAlive,
  metadataPath,
  nowIso,
  pathExists,
  forceKillTreeWindows,
  pidCommandLine,
  relativeAge,
  shortHome,
} from './helpers';
import {
  buildCurrentTask,
  buildRuntimeSurface,
  deriveOwnedStatus,
  formatChildExit,
  latestRun,
  type OwnedLifecycleContext,
} from './lifecycle';
import type { OwnedRunController } from './run-controller';
import type { OwnedSessionIo } from './session-io';
import type {
  OwnedFleetAdditions,
  OwnedRuntimeAdapter,
  OwnedSessionRecord,
} from './types';
import type {
  AgentSummary,
  EventItem,
  ReviewArtifact,
  SquadSummary,
} from '@/lib/fleet/types';

export function createFleetComputer({
  adapter,
  root,
  surfacePrefix,
  runtimeId,
  squadId,
  squadName,
  lifecycleContext,
  io,
  runController,
  withSurfaceLock,
  invalidateFleetCache,
}: {
  adapter: OwnedRuntimeAdapter;
  root: string;
  surfacePrefix: string;
  runtimeId: string;
  squadId: string;
  squadName: string;
  lifecycleContext: OwnedLifecycleContext;
  io: OwnedSessionIo;
  runController: OwnedRunController;
  withSurfaceLock: <T>(surfaceId: string, fn: () => Promise<T>) => Promise<T>;
  invalidateFleetCache: () => void;
}) {
  async function computeFleetAdditions(): Promise<OwnedFleetAdditions> {
    const sessionDirs = await io.listSessionDirs();
    if (!sessionDirs.length) {
      return {
        agents: [],
        squads: [],
        events: [],
        artifacts: [],
        ownedThreadIds: [],
      };
    }

    const settled = await Promise.all(
      sessionDirs.map(async (sessionDir): Promise<OwnedSessionRecord | null> => {
        try {
          const filePath = metadataPath(sessionDir);
          if (!(await pathExists(filePath))) return null;
          const session = await io.loadSession(sessionDir);
          await runController.refreshSession(session);
          return session;
        } catch {
          return null;
        }
      }),
    );
    const allSessions: OwnedSessionRecord[] = settled.filter(
      (session): session is OwnedSessionRecord => session !== null,
    );

    const now = Date.now();
    const sessions = allSessions.filter((session) => {
      if (session.activeRun) return true;
      const latest = latestRun(session);
      const lastActivityStr = latest?.finishedAt ?? latest?.startedAt ?? session.updatedAt;
      const ageMs = Math.max(0, now - new Date(lastActivityStr).getTime());
      return ageMs < OWNED_STALE_WINDOW_MS;
    });

    const agents: AgentSummary[] = sessions
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((session) => {
        const running = Boolean(session.activeRun);
        const status = deriveOwnedStatus(lifecycleContext, session);
        const runtimeSurface = buildRuntimeSurface(lifecycleContext, session, running);
        const lifecycle = runtimeSurface.lifecycle;
        const lastRun = latestRun(session);
        const lifecycleLabel = lifecycle?.availability === 'running'
          ? 'owned active'
          : lifecycle?.lastOutcome === 'failed'
            ? 'owned failed'
            : lifecycle?.lastOutcome === 'interrupted'
              ? 'owned interrupted'
              : lifecycle?.availability === 'awaiting-thread'
                ? 'owned warming'
                : 'owned ready';
        return {
          id: session.surfaceId,
          name: session.title,
          squadId,
          runtime: runtimeId,
          model: `${runtimeId} owned`,
          status,
          currentTask: buildCurrentTask(lifecycleContext, session, running),
          workspace: shortHome(session.repoPath),
          branch: session.branch ?? 'detached',
          sessionKey: session.surfaceId,
          approvalStatus: 'none',
          lastEventAt: relativeAge(lastRun?.finishedAt ?? lastRun?.startedAt ?? session.createdAt),
          context: {
            usedPercent: 0,
            trend: running ? 'rising' : 'stable',
          },
          alerts: lifecycle?.lastOutcome === 'failed' ? 1 : 0,
          sessionId: session.threadId ?? session.surfaceId,
          sessionKind: 'owned-runtime',
          surfaceLabel: `${adapter.squadShortName} terminal • ${lifecycleLabel}`,
          runtimeSurface,
          tmuxSession: session.activeRun?.tmuxSession ?? lastRun?.tmuxSession,
        } satisfies AgentSummary;
      });

    const squad: SquadSummary | null = agents.length
      ? {
          id: squadId,
          name: squadName,
          status: agents.some((agent) => agent.status === 'running') ? 'healthy' : 'watching',
          throughputLabel: `${agents.length} IDE-owned surface${agents.length === 1 ? '' : 's'}`,
          blockers: 0,
          alerts: 0,
          liveSessions: agents.length,
          members: agents.map((agent) => agent.id),
        }
      : null;

    const sessionBySurfaceId = new Map(sessions.map((session) => [session.surfaceId, session]));
    const events: EventItem[] = agents.slice(0, 4).map((agent) => {
      const eventSession = sessionBySurfaceId.get(agent.id);
      const eventLastRun = eventSession ? latestRun(eventSession) : undefined;
      return {
        id: `evt-${agent.id}`,
        agentId: agent.id,
        squadId: agent.squadId,
        severity: agent.status === 'running' ? 'info' : agent.status === 'failed' ? 'critical' : agent.status === 'waiting' ? 'warning' : 'success',
        title: `${agent.name} • ${agent.surfaceLabel}`,
        detail: `${agent.currentTask}${agent.runtimeSurface?.lifecycle?.lastOutcome ? ` • last ${agent.runtimeSurface.lifecycle.lastOutcome}` : ''}${formatChildExit(eventLastRun?.childExit)}${agent.runtimeSurface?.reviewContext?.repoSlug ? ` • ${agent.runtimeSurface.reviewContext.repoSlug}` : ''}`,
        timestamp: agent.lastEventAt,
      };
    });

    const artifacts: ReviewArtifact[] = agents.slice(0, 3).map((agent) => ({
      kind: 'run_log',
      title: `${agent.name} owned tail`,
      state: agent.runtimeSurface?.lifecycle?.lastOutcome === 'failed' ? 'new' : 'reviewing',
      agentId: agent.id,
      detail: agent.runtimeSurface?.lifecycle?.lastOutcome
        ? `Readable JSON tail recovered from an IDE-owned ${adapter.squadShortName} exec/resume run. Last outcome: ${agent.runtimeSurface.lifecycle.lastOutcome}.`
        : `Readable JSON tail recovered from an IDE-owned ${adapter.squadShortName} exec/resume run.`,
    }));

    return {
      agents,
      squads: squad ? [squad] : [],
      events,
      artifacts,
      sourceLabel: `Owned ${adapter.squadShortName} launch registry`,
      note: agents.length
        ? `IDE-owned ${adapter.squadShortName} surfaces can now launch, resume between runs, and interrupt active runs. Discovered ${adapter.squadShortName} terminals remain watch-only.`
        : undefined,
      ownedThreadIds: agents.map((agent) => agent.sessionId ?? '').filter((value) => value && !value.startsWith(surfacePrefix)),
    };
  }

  function sessionLastActivityMs(session: OwnedSessionRecord): number {
    const latest = latestRun(session);
    const candidates = [latest?.finishedAt, latest?.startedAt, session.updatedAt]
      .map((value) => (value ? new Date(value).getTime() : Number.NaN))
      .filter((value) => Number.isFinite(value));
    return candidates.length > 0 ? Math.max(...candidates) : 0;
  }

  async function markActiveRunOrphaned(session: OwnedSessionRecord, reason: string) {
    const activeRun = session.activeRun;
    if (!activeRun) return false;
    const costLine = await runController.readCostLine(activeRun);
    const orphanedAt = nowIso();
    const inIsolatedTestContext = Boolean(process.env.O8_TEST_DATA_DIR_PINNED);
    if (!inIsolatedTestContext && await isOwnedRunAlive(activeRun)) {
      try {
        if (activeRun.tmuxSession) {
          await signalBridgeTerminalSession(activeRun.tmuxSession, 'SIGINT');
        } else {
          const cmd = await pidCommandLine(activeRun.pid);
          if (cmd && cmd.includes(adapter.binaryName)) {
            if (process.platform === 'win32') {
              await forceKillTreeWindows(activeRun.pid);
            } else {
              process.kill(-activeRun.pid, 'SIGINT');
            }
          }
        }
      } catch (error) {
        console.warn(`[owned-store] Failed to interrupt orphaned ${runtimeId} session ${session.surfaceId}:`, error instanceof Error ? error.message : error);
      }
    }
    session.orphanedAt = orphanedAt;
    session.orphanedReason = reason;
    session.orphanedCostLine = costLine;
    session.latestSummary = costLine ? `${reason} Cost: ${costLine}` : reason;
    session.activeRun = undefined;
    session.recentRuns = session.recentRuns.map((run) =>
      run.id === activeRun.id
        ? { ...run, outcome: 'interrupted', interruptRequestedAt: orphanedAt, finishedAt: run.finishedAt ?? orphanedAt }
        : run,
    );
    await io.saveSession(session);
    console.warn(`[owned-store] Orphaned ${runtimeId} session ${session.surfaceId}: ${reason}${costLine ? ` cost=${costLine}` : ''}`);
    return true;
  }

  async function sweepOrphanedSessions(activeSurfaceIds: Set<string>, maxAgeMs: number): Promise<number> {
    let archived = 0;
    for (const sessionDir of await io.listSessionDirs()) {
      try {
        if (!(await pathExists(metadataPath(sessionDir)))) continue;
        const session = await io.loadSession(sessionDir);
        if (activeSurfaceIds.has(session.surfaceId)) continue;
        if (Date.now() - sessionLastActivityMs(session) < maxAgeMs) continue;
        const didArchive = await withSurfaceLock(session.surfaceId, async () => {
          if (!(await pathExists(metadataPath(sessionDir)))) return false;
          const current = await io.loadSession(sessionDir);
          if (activeSurfaceIds.has(current.surfaceId)) return false;
          if (Date.now() - sessionLastActivityMs(current) < maxAgeMs) return false;
          if (current.activeRun) {
            await markActiveRunOrphaned(current, `No lane referenced this owned ${runtimeId} session within ${Math.round(maxAgeMs / 1000)}s of launch.`);
          }
          const result = await archiveOwnedSessionDir(root, current);
          return result.archived;
        });
        if (didArchive) archived += 1;
      } catch {
        // best-effort per dir; never block startup
      }
    }
    if (archived > 0) invalidateFleetCache();
    return archived;
  }

  return {
    computeFleetAdditions,
    sweepOrphanedSessions,
  };
}
