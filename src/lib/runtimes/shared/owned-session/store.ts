/**
 * createOwnedSessionStore — the generic primitive.
 *
 * Takes a per-runtime `OwnedRuntimeAdapter` and returns a fully-wired
 * `OwnedSessionStore` covering launch, resume, interrupt, runtime tail,
 * review packet, fleet additions, telemetry sources, and review disposition.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { signalBridgeTerminalSession } from '@/lib/runtime/pty-bridge';
import { chainOnKey } from '@/lib/util/keyed-promise-chain';

import {
  archiveOwnedSessionDir,
  readOwnedSessionState,
  restoreArchivedOwnedSessionDir,
} from './archive';
import { createFleetComputer } from './fleet';
import {
  DEFAULT_AUTO_RETRY_DELAY_MS,
  OWNED_FLEET_TTL_MS,
  compactText,
  ensureDir,
  isPidAlive,
  nowIso,
  forceKillTreeWindows,
  pidCommandLine,
  resolveRepoContext,
  validateWorkspace,
} from './helpers';
import { createOwnedSessionIo } from './session-io';
import { createOwnedRunController } from './run-controller';
import { createReviewTailController } from './review-tail';
import type {
  OwnedFleetAdditions,
  OwnedLaunchRequest,
  OwnedLaunchResponse,
  OwnedReviewDisposition,
  OwnedRuntimeAdapter,
  OwnedSessionStore,
} from './types';

export function createOwnedSessionStore(adapter: OwnedRuntimeAdapter): OwnedSessionStore {
  const runtimeId = adapter.runtimeId;
  const surfacePrefix = adapter.surfaceIdPrefix;
  const root = process.env[adapter.rootEnvVar] || adapter.rootDefault;
  const sessionIdPrefix = adapter.sessionIdPrefix ?? `${runtimeId}-owned-`;
  const squadId = `squad-${runtimeId}-owned`;
  const squadName = `${adapter.squadShortName} Owned`;
  const stderrNoise = adapter.stderrNoise ?? [];
  const retryDelayMs = adapter.retryDelayMs ?? DEFAULT_AUTO_RETRY_DELAY_MS;
  const humanLabel = adapter.humanLabel;
  const launchGroupLabel = adapter.launchGroupLabel ?? 'Launch turn';
  const resumeGroupLabel = adapter.resumeGroupLabel ?? 'Resume turn';
  const lifecycleContext = { adapter, runtimeId };
  const ACTIVE_ORPHAN_GRACE_MS = 120_000;

  let fleetCache: { value: OwnedFleetAdditions; cachedAt: number } | null = null;
  let fleetInflight: Promise<OwnedFleetAdditions> | null = null;
  let fleetGeneration = 0;

  function invalidateFleetCache() {
    fleetGeneration += 1;
    fleetCache = null;
    fleetInflight = null;
  }

  const surfaceOpChains = new Map<string, Promise<unknown>>();

  function withSurfaceLock<T>(surfaceId: string, fn: () => Promise<T>): Promise<T> {
    return chainOnKey(surfaceOpChains, surfaceId, fn);
  }

  const io = createOwnedSessionIo({
    root,
    surfacePrefix,
    invalidateFleetCache,
  });
  const runController = createOwnedRunController({
    adapter,
    runtimeId,
    humanLabel,
    retryDelayMs,
    stderrNoise,
    io,
    withSurfaceLock,
    invalidateFleetCache,
  });
  const reviewTailController = createReviewTailController({
    adapter,
    lifecycleContext,
    io,
    runController,
    stderrNoise,
    launchGroupLabel,
    resumeGroupLabel,
  });
  const fleetComputer = createFleetComputer({
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
  });

  async function launch(request: OwnedLaunchRequest): Promise<OwnedLaunchResponse> {
    const prompt = request.prompt.trim();
    if (!prompt) {
      throw new Error('prompt is required');
    }

    const repoPath = await validateWorkspace(request.cwd);
    const repo = await resolveRepoContext(repoPath);
    const id = `${sessionIdPrefix}${Date.now()}-${randomUUID().slice(0, 8)}`;
    const sessionDir = path.join(await io.ensureRoot(), id);
    await ensureDir(sessionDir);

    const session = {
      surfaceId: `${surfacePrefix}${id}`,
      laneId: request.laneId?.trim() || undefined,
      packetId: request.packetId?.trim() || undefined,
      sessionDir,
      cwd: repoPath,
      repoPath,
      repoSlug: repo.repoSlug,
      branch: repo.branch,
      head: repo.head,
      title: repo.title,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      latestPrompt: prompt,
      latestSummary: compactText(prompt, 140) || `Owned ${adapter.squadShortName} session launched from o8.`,
      model: request.model?.trim() || adapter.defaultModel || undefined,
      effort: request.effort,
      reviewDisposition: 'watching' as const,
      reviewDispositionUpdatedAt: nowIso(),
      recentRuns: [],
    };

    await io.saveSession(session);
    const run = await runController.spawnOwnedRun(session, prompt, 'launch');
    invalidateFleetCache();
    void sweepRecentlyOrphanedActiveRuns().catch(() => {});
    const failedBeforeLaunch = run.outcome === 'failed';

    return {
      ok: !failedBeforeLaunch,
      runtime: runtimeId,
      surfaceId: session.surfaceId,
      note: failedBeforeLaunch
        ? session.latestSummary
        : `Owned ${adapter.squadShortName} run launched for ${repo.title}. It will become mutable through resume/interrupt only because o8 owns this surface.`,
    };
  }

  function resume(surfaceId: string, prompt: string) {
    return withSurfaceLock(surfaceId, () => resumeInner(surfaceId, prompt));
  }

  async function resumeInner(surfaceId: string, prompt: string) {
    let session = await io.findSession(surfaceId);
    let coldRestored = false;

    if (!session) {
      const archived = await io.findArchivedSession(surfaceId);
      if (archived?.threadId) {
        const restore = await restoreArchivedOwnedSessionDir(root, surfaceId, surfacePrefix);
        if (restore.restored) {
          session = await io.findSession(surfaceId);
          coldRestored = Boolean(session);
          if (coldRestored) invalidateFleetCache();
        } else {
          console.warn(`[owned-store] Cold-resume restore failed for ${surfaceId}: ${restore.note}`);
        }
      }
    }
    if (!session) {
      throw new Error(`Owned ${adapter.squadShortName} session was not found.`);
    }

    const rollbackColdRestore = async () => {
      if (!coldRestored || !session) return;
      try {
        await archiveOwnedSessionDir(root, session);
        invalidateFleetCache();
      } catch (error) {
        console.warn(`[owned-store] Failed to re-archive ${surfaceId} after aborted cold resume:`, error);
      }
    };

    try {
      await runController.refreshSession(session);

      if (session.activeRun && isPidAlive(session.activeRun.pid)) {
        throw new Error(`This owned ${adapter.squadShortName} session still has an active run. Wait for it to settle or interrupt it first.`);
      }
      if (!session.threadId) {
        throw new Error(`This owned ${adapter.squadShortName} session does not have a thread id yet, so resume is not available.`);
      }

      const run = await runController.spawnOwnedRun(session, prompt.trim(), 'resume');
      if (run.outcome === 'failed' && coldRestored) {
        await rollbackColdRestore();
      }
      invalidateFleetCache();
      return {
        ok: run.outcome !== 'failed',
        note: run.outcome === 'failed'
          ? session.latestSummary
          : coldRestored
            ? `Cold resume: the archived IDE-owned ${adapter.squadShortName} session was restored and its saved thread resumed (fresh process, no warm context beyond the thread).`
            : `Queued a new turn on the IDE-owned ${adapter.squadShortName} session via resume.`,
      };
    } catch (error) {
      await rollbackColdRestore();
      throw error;
    }
  }

  function interrupt(surfaceId: string) {
    return withSurfaceLock(surfaceId, () => interruptInner(surfaceId));
  }

  async function interruptInner(surfaceId: string) {
    const session = await io.findSession(surfaceId);
    if (!session) {
      throw new Error(`Owned ${adapter.squadShortName} session was not found.`);
    }
    await runController.refreshSession(session);

    if (!session.activeRun || !isPidAlive(session.activeRun.pid)) {
      return { interrupted: false, note: `No active owned ${adapter.squadShortName} run was in flight.` };
    }

    try {
      if (session.activeRun.tmuxSession) {
        await signalBridgeTerminalSession(session.activeRun.tmuxSession, 'SIGINT');
      } else {
        const cmd = await pidCommandLine(session.activeRun.pid);
        if (cmd && cmd.includes(adapter.binaryName)) {
          // Windows has no process groups addressed by negative pid and no
          // SIGINT delivery to another tree; the CLI is also a grandchild of
          // the interpreter, so a single-pid kill would leave it running.
          if (process.platform === 'win32') {
            // An access-denied taskkill must not be reported as a clean stop —
            // the operator would believe a still-running agent had been halted.
            // But taskkill also exits non-zero when the pid is ALREADY GONE,
            // which is the benign race of a run finishing between the liveness
            // check above and this call. Only a process that is still alive
            // after a failed kill is a real failure.
            if (!await forceKillTreeWindows(session.activeRun.pid)
              && isPidAlive(session.activeRun.pid)) {
              throw new Error(`taskkill could not stop pid ${session.activeRun.pid}`);
            }
          } else {
            process.kill(-session.activeRun.pid, 'SIGINT');
          }
        } else {
          console.warn(
            `[owned-store] Skipping interrupt signal for ${surfaceId}: pid ${session.activeRun.pid} no longer matches an owned ${adapter.binaryName} run (${cmd ?? 'process gone'})`,
          );
        }
      }
      session.activeRun = {
        ...session.activeRun,
        outcome: 'interrupted',
        interruptRequestedAt: nowIso(),
      };
      session.recentRuns = session.recentRuns.map((run) =>
        run.id === session.activeRun?.id
          ? {
              ...run,
              outcome: 'interrupted',
              interruptRequestedAt: session.activeRun?.interruptRequestedAt,
            }
          : run,
      );
      await io.saveSession(session);
      invalidateFleetCache();
      return { interrupted: true, note: `Interrupt sent to the active IDE-owned ${adapter.squadShortName} run.` };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : `Unable to interrupt the owned ${adapter.squadShortName} run.`);
    }
  }

  function setReviewDisposition(surfaceId: string, disposition: OwnedReviewDisposition) {
    return withSurfaceLock(surfaceId, () => setReviewDispositionInner(surfaceId, disposition));
  }

  async function setReviewDispositionInner(surfaceId: string, disposition: OwnedReviewDisposition) {
    const session = await io.findSession(surfaceId);
    if (!session) {
      throw new Error(`Owned ${adapter.squadShortName} session was not found.`);
    }

    session.reviewDisposition = disposition;
    session.reviewDispositionUpdatedAt = nowIso();
    await io.saveSession(session);
    invalidateFleetCache();

    return {
      disposition,
      note: disposition === 'resolved'
        ? 'Marked this owned result resolved. It stays visible, but no longer needs active attention unless new evidence appears.'
        : 'Switched this owned result back to keep-watching mode.',
    };
  }

  async function getFleetAdditions(options: { fresh?: boolean } = {}): Promise<OwnedFleetAdditions> {
    const fresh = options.fresh ?? false;
    const now = Date.now();
    const generation = fleetGeneration;
    if (!fresh && fleetCache && (now - fleetCache.cachedAt) < OWNED_FLEET_TTL_MS) {
      return fleetCache.value;
    }

    if (!fresh && fleetInflight) {
      return fleetInflight;
    }

    const promise = fleetComputer.computeFleetAdditions();

    fleetInflight = promise;
    return promise.finally(() => {
      if (fleetInflight === promise) {
        fleetInflight = null;
      }
    }).then((value) => {
      if (generation === fleetGeneration) {
        fleetCache = { value, cachedAt: Date.now() };
      }
      return value;
    });
  }

  const TIMER_KEY = Symbol.for(`o8.ownedSession.refreshTimer.${runtimeId}`);
  const globalStore = globalThis as unknown as Record<symbol, NodeJS.Timeout | undefined>;
  if (!globalStore[TIMER_KEY]) {
    const timer = setInterval(() => {
      getFleetAdditions({ fresh: true }).catch((err) => {
        console.warn(`[owned-store] ${runtimeId} refresh tick failed:`, err instanceof Error ? err.message : err);
      });
    }, 15_000);
    if (typeof timer.unref === 'function') timer.unref();
    globalStore[TIMER_KEY] = timer;
  }

  async function sweepRecentlyOrphanedActiveRuns(): Promise<number> {
    const { listActiveLanes } = await import('@/lib/lane/registry');
    const activeSurfaceIds = new Set(
      listActiveLanes()
        .map((lane) => lane.sessionKey?.trim())
        .filter((key): key is string => Boolean(key)),
    );
    return fleetComputer.sweepOrphanedSessions(activeSurfaceIds, ACTIVE_ORPHAN_GRACE_MS);
  }

  void sweepRecentlyOrphanedActiveRuns().catch(() => {});

  return {
    runtimeId,
    surfaceIdPrefix: surfacePrefix,
    launch,
    resume,
    interrupt,
    getRuntimeTail: reviewTailController.getRuntimeTail,
    getReviewPacket: reviewTailController.getReviewPacket,
    getFleetAdditions,
    sessionState: (surfaceId) => readOwnedSessionState(root, surfaceId, surfacePrefix),
    archiveSession: io.archiveSession,
    sweepOrphanedSessions: fleetComputer.sweepOrphanedSessions,
    getTelemetrySources: reviewTailController.getTelemetrySources,
    setReviewDisposition,
    invalidateFleetCache,
  };
}
