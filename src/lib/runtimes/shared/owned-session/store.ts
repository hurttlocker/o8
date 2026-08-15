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
  getOrPinPacketRuntimeIdentity,
  getSelectedRuntimeIdentity,
} from '@/lib/runtime/identity-catalog';

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
import {
  OwnedWorkspaceUnavailableError,
  type OwnedWorkspaceSpawnGuard,
} from './workspace-spawn-guard';
import type {
  OwnedFleetAdditions,
  OwnedLaunchRequest,
  OwnedLaunchResponse,
  OwnedReviewDisposition,
  OwnedRuntimeAdapter,
  OwnedSessionRecord,
  OwnedSessionStore,
  OwnedWorkspaceBinding,
  OwnedWorkspaceBindingReceipt,
  RebindOwnedWorkspaceInput,
  RebindOwnedWorkspaceResult,
} from './types';

export function createOwnedSessionStore(
  adapter: OwnedRuntimeAdapter,
  options: { workspaceSpawnGuard?: OwnedWorkspaceSpawnGuard } = {},
): OwnedSessionStore {
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
  const workspaceSpawnGuard: OwnedWorkspaceSpawnGuard = options.workspaceSpawnGuard ?? (async (input) => {
    try {
      const { inspectOwnedWorkspaceMaterialization } = await import('@/lib/workspace/materialization-guard');
      const decision = await inspectOwnedWorkspaceMaterialization(input);
      return decision;
    } catch {
      return { status: 'unknown', note: 'Owned workspace snapshot truth could not be loaded, so the run was refused.' };
    }
  });

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
    workspaceSpawnGuard,
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
    let selectedIdentity: Awaited<ReturnType<typeof getSelectedRuntimeIdentity>> = null;
    if (adapter.isolatedConfigHomeEnv && adapter.defaultConfigHome && request.packetId) {
      const defaultConfigHome = adapter.defaultConfigHome();
      let latestPacketSession: OwnedSessionRecord | null = null;
      for (const sessionDir of await io.listSessionDirs()) {
        try {
          const candidate = await io.loadSession(sessionDir);
          if (candidate.packetId === request.packetId
            && candidate.identity
            && (!latestPacketSession || candidate.updatedAt > latestPacketSession.updatedAt)) {
            latestPacketSession = candidate;
          }
        } catch {
          // One corrupt legacy session must not block a new, otherwise valid launch.
        }
      }
      const existingPacketIdentity = latestPacketSession?.identity;
      selectedIdentity = await getOrPinPacketRuntimeIdentity({
        runtime: runtimeId,
        packetId: request.packetId,
        preferred: existingPacketIdentity,
        fallback: {
          id: `${runtimeId}-local-default`,
          label: 'Current local sign-in',
          configHomeRef: defaultConfigHome,
        },
      });
    } else if (adapter.isolatedConfigHomeEnv) {
      selectedIdentity = await getSelectedRuntimeIdentity(runtimeId);
    }

    const createdAt = nowIso();
    const session = {
      surfaceId: `${surfacePrefix}${id}`,
      launchMutationId: request.clientMutationId?.trim() || undefined,
      laneId: request.laneId?.trim() || undefined,
      packetId: request.packetId?.trim() || undefined,
      sessionDir,
      cwd: repoPath,
      repoPath,
      workspaceBinding: {
        logicalWorkspaceId: request.packetId?.trim()
          ? `packet:${request.packetId.trim()}`
          : `session:${surfacePrefix}${id}`,
        repositoryUuid: null,
        packetId: request.packetId?.trim() || null,
        cwd: repoPath,
        version: 1,
        verifiedAt: createdAt,
      },
      repoSlug: repo.repoSlug,
      branch: repo.branch,
      head: repo.head,
      title: repo.title,
      createdAt,
      updatedAt: createdAt,
      latestPrompt: prompt,
      latestSummary: compactText(prompt, 140) || `Owned ${adapter.squadShortName} session launched from o8.`,
      model: request.model?.trim() || adapter.defaultModel || undefined,
      effort: request.effort,
      runtimeConfig: request.runtimeConfig ? { ...request.runtimeConfig } : undefined,
      identity: selectedIdentity ? {
        id: selectedIdentity.id,
        label: selectedIdentity.label,
        configHomeRef: selectedIdentity.configHomeRef,
      } : undefined,
      reviewDisposition: 'watching' as const,
      reviewDispositionUpdatedAt: nowIso(),
      recentRuns: [],
      runIdentityLedger: { version: 1 as const, totalRuns: 0, complete: true },
    };

    await io.saveSession(session);
    let run;
    try {
      run = await withSurfaceLock(session.surfaceId, () => (
        runController.spawnOwnedRun(session, prompt, 'launch')
      ));
    } catch (error) {
      if (error instanceof OwnedWorkspaceUnavailableError) {
        return {
          ok: false, runtime: runtimeId, surfaceId: session.surfaceId,
          note: error.message, sideEffect: error.sideEffect,
        };
      }
      throw error;
    }
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

      if (session.activeRun?.spawnState === 'prepared') {
        throw new Error(`This owned ${adapter.squadShortName} session has an unresolved prepared run. Wait for marker reconciliation before resuming it.`);
      }
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
      if (error instanceof OwnedWorkspaceUnavailableError) {
        return { ok: false, note: error.message, sideEffect: error.sideEffect };
      }
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

    if (session.activeRun?.spawnState === 'prepared') {
      return {
        interrupted: false,
        note: `The owned ${adapter.squadShortName} run has a durable prepared marker but no signalable PID yet; it remains unresolved rather than being reported stopped.`,
      };
    }
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

  async function getSessionIdentityId(surfaceId: string): Promise<string | null> {
    const session = await io.findSession(surfaceId) ?? await io.findArchivedSession(surfaceId);
    return session?.identity?.id?.trim() || null;
  }

  function normalizedWorkspaceBinding(session: OwnedSessionRecord): OwnedWorkspaceBinding {
    return session.workspaceBinding ?? {
      logicalWorkspaceId: session.packetId?.trim()
        ? `packet:${session.packetId.trim()}`
        : `session:${session.surfaceId}`,
      repositoryUuid: null,
      packetId: session.packetId?.trim() || null,
      cwd: path.resolve(session.cwd),
      version: 1,
      verifiedAt: session.updatedAt || session.createdAt,
    };
  }

  function bindingReceipt(
    session: OwnedSessionRecord,
    sessionState: 'active' | 'archived',
  ): OwnedWorkspaceBindingReceipt {
    const recentRuns = Array.isArray(session.recentRuns) ? session.recentRuns : [];
    const ledger = session.runIdentityLedger;
    const ledgerValid = ledger?.version === 1
      && (ledger.totalRuns === null
        ? !ledger.complete
        : Number.isSafeInteger(ledger.totalRuns)
          && ledger.totalRuns >= recentRuns.length
          && (!ledger.complete || ledger.totalRuns === recentRuns.length));
    const retainedRuns = [] as OwnedWorkspaceBindingReceipt['retainedRuns'];
    const seenRuns = new Map<string, OwnedWorkspaceBindingReceipt['retainedRuns'][number]>();
    let retainedRunsComplete = Boolean(ledgerValid && ledger?.complete)
      && new Set(recentRuns.map((run) => run.id)).size === recentRuns.length
      && (!session.activeRun || recentRuns.some((run) => run.id === session.activeRun?.id));
    for (const run of [session.activeRun, ...recentRuns]) {
      if (!run) continue;
      if (run.spawnState === 'reconciled_clear'
        && run.pid <= 0
        && !run.processGroupId
        && !run.tmuxSession) continue;
      if (run.pid <= 0 && !run.processGroupId && !run.processMarker && !run.tmuxSession) continue;
      const identity = {
        id: run.id,
        outcome: run.outcome,
        pid: run.pid,
        commandIdentity: run.commandIdentity,
        processGroupId: run.processGroupId,
        processMarker: run.processMarker,
        spawnState: run.spawnState,
        tmuxSession: run.tmuxSession,
      };
      const prior = seenRuns.get(run.id);
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(identity)) retainedRunsComplete = false;
        continue;
      }
      if (!run.id.trim() || retainedRuns.length === 16) {
        retainedRunsComplete = false;
        continue;
      }
      seenRuns.set(run.id, identity);
      retainedRuns.push(identity);
    }
    return {
      surfaceId: session.surfaceId,
      runtimeId,
      sessionState,
      binding: normalizedWorkspaceBinding(session),
      activeRun: session.activeRun ? {
        pid: session.activeRun.pid,
        commandIdentity: session.activeRun.commandIdentity,
        processGroupId: session.activeRun.processGroupId,
        processMarker: session.activeRun.processMarker,
        spawnState: session.activeRun.spawnState,
        tmuxSession: session.activeRun.tmuxSession,
      } : null,
      retainedRuns,
      retainedRunsComplete,
      retainedRunTotal: ledgerValid ? ledger?.totalRuns ?? null : null,
    };
  }

  function getWorkspaceBinding(surfaceId: string): Promise<OwnedWorkspaceBindingReceipt | null> {
    return withSurfaceLock(surfaceId, async () => {
      const active = await io.findSession(surfaceId);
      if (active) {
        await runController.reconcilePreparedRuns(active);
        return bindingReceipt(active, 'active');
      }
      const archived = await io.findArchivedSession(surfaceId);
      return archived ? bindingReceipt(archived, 'archived') : null;
    });
  }

  function rebindWorkspace(
    surfaceId: string,
    input: RebindOwnedWorkspaceInput,
  ): Promise<RebindOwnedWorkspaceResult> {
    return withSurfaceLock(surfaceId, async () => {
      const session = await io.findSession(surfaceId);
      if (!session) {
        const archived = await io.findArchivedSession(surfaceId);
        return archived
          ? {
              status: 'archived' as const,
              receipt: bindingReceipt(archived, 'archived'),
              note: 'Archived owned sessions cannot be rebound in place.',
            }
          : { status: 'missing' as const, receipt: null, note: 'Owned session was not found.' };
      }
      await runController.reconcilePreparedRuns(session);
      const current = normalizedWorkspaceBinding(session);
      const expectedCwd = path.resolve(input.expectedCwd);
      const nextCwd = path.resolve(input.nextCwd);
      const identityMatches = current.logicalWorkspaceId === input.logicalWorkspaceId
        && (current.repositoryUuid === null || current.repositoryUuid === input.repositoryUuid)
        && (current.packetId === null || current.packetId === input.packetId);
      const replayed = identityMatches
        && current.repositoryUuid === input.repositoryUuid
        && current.packetId === input.packetId
        && current.cwd === nextCwd
        && current.version === input.expectedVersion + 1;
      if (replayed) {
        return { status: 'idempotent' as const, receipt: bindingReceipt(session, 'active') };
      }
      if (!identityMatches || current.cwd !== expectedCwd || current.version !== input.expectedVersion) {
        return {
          status: 'conflict' as const,
          receipt: bindingReceipt(session, 'active'),
          note: 'Owned workspace binding changed before the rebind could be applied.',
        };
      }
      if (session.activeRun) {
        return {
          status: 'conflict' as const,
          receipt: bindingReceipt(session, 'active'),
          note: 'An owned run is still attached to this workspace binding.',
        };
      }
      const nextBinding: OwnedWorkspaceBinding = {
        logicalWorkspaceId: input.logicalWorkspaceId,
        repositoryUuid: input.repositoryUuid,
        packetId: input.packetId,
        cwd: nextCwd,
        version: current.version + 1,
        verifiedAt: nowIso(),
      };
      session.cwd = nextCwd;
      session.repoPath = nextCwd;
      session.workspaceBinding = nextBinding;
      await io.saveSession(session);
      invalidateFleetCache();
      return { status: 'rebound' as const, receipt: bindingReceipt(session, 'active') };
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
    getSessionIdentityId,
    getWorkspaceBinding,
    rebindWorkspace,
    setReviewDisposition,
    invalidateFleetCache,
  };
}
