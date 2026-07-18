/**
 * createOwnedSessionStore — the generic primitive.
 *
 * Takes a per-runtime `OwnedRuntimeAdapter` and returns a fully-wired
 * `OwnedSessionStore` covering launch, resume, interrupt, runtime tail,
 * review packet, fleet additions, telemetry sources, and review disposition.
 *
 * Invariants preserved from the Codex implementation:
 *   - Surface ids keep the adapter's prefix (Codex: 'codex-owned:').
 *   - tmux session naming uses `cortex-<runtimeId>-<shortId>`.
 *   - Fleet cache is per-store (20s TTL, generation counter, inflight dedupe).
 *   - Stale filtering (>24h idle + no active run) removes sessions from fleet.
 *   - Auto-retry once within 60s of a fresh failure when `autoRetry` is on.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliNotFoundError, resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import { getRuntimeRepoReview } from '@/lib/git/runtime-review';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { chainOnKey } from '@/lib/util/keyed-promise-chain';
import { getWorktreeManager } from '@/lib/worktree/launch';
import { tmuxSessionName } from '@/lib/terminal/tmux';
import {
  signalBridgeTerminalSession,
  spawnBridgeTerminalSession,
} from '@/lib/runtime/pty-bridge';
import {
  archiveOwnedSessionDir,
  archivedSessionPathForSurfaceId,
  restoreArchivedOwnedSessionDir,
} from './archive';
import type {
  AgentSummary,
  EventItem,
  ReviewArtifact,
  RuntimeReviewPacket,
  RuntimeSurfaceLifecycle,
  RuntimeSurfaceSummary,
  SquadSummary,
} from '@/lib/fleet/types';
import {
  ACTIVE_WINDOW_MS,
  AUTO_RETRY_FRESHNESS_MS,
  DEFAULT_AUTO_RETRY_DELAY_MS,
  MAX_AUTO_RETRIES,
  OWNED_FLEET_TTL_MS,
  OWNED_STALE_WINDOW_MS,
  RECENT_WINDOW_MS,
  RUNS_DIR,
  compactText,
  deriveRunOutcome,
  ensureDir,
  formatClock,
  isOwnedRunAlive,
  isPidAlive,
  lifecycleAvailabilityLabel,
  metadataPath,
  nowIso,
  pathExists,
  pidCommandLine,
  readJsonFile,
  relativeAge,
  resolveRepoContext,
  shortHome,
  validateWorkspace,
  writeJsonFile,
} from './helpers';
import type {
  OwnedFleetAdditions,
  OwnedArchiveResponse,
  OwnedLaunchRequest,
  OwnedLaunchResponse,
  OwnedReviewDisposition,
  OwnedRunMode,
  OwnedRunRecord,
  OwnedRuntimeAdapter,
  OwnedSessionRecord,
  OwnedSessionStore,
  OwnedTailEntry,
  OwnedTailGroup,
  OwnedChildExitOutcome,
  ParsedRunLog,
} from './types';
import { stageMissingCliRun } from './missing-cli';
import { crashSurvivableWorkersEnabled } from './crash-survival';
import { getOrCreateLocalWorkerToken } from '@/lib/auth/worker-token';
import { ensureDispatchBackendReady } from '@/lib/runtimes/shared/dispatch-readiness';
import { pathWithNodeRuntime } from '@/lib/util/node-on-path';
import { observeChildExit, readAbnormalStderrTail } from './exit-outcome';

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
  const ACTIVE_ORPHAN_GRACE_MS = 120_000;

  function quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  // Per-store fleet cache + inflight dedupe. Codex and Gemini each get their own.
  let fleetCache: { value: OwnedFleetAdditions; cachedAt: number } | null = null;
  let fleetInflight: Promise<OwnedFleetAdditions> | null = null;
  let fleetGeneration = 0;
  function invalidateFleetCache() {
    fleetGeneration += 1;
    fleetCache = null;
    fleetInflight = null;
  }

  // ── Per-surface serialization ──────────────────────────────────────────────
  // Mutating ops are read-modify-write of one session.json; two running
  // concurrently on the same surface lose writes (interrupts that "don't
  // stick", clobbered threadIds). Chain them per surfaceId. Read paths (fleet
  // refresh) stay lock-free — their derived state converges on the next tick.
  const surfaceOpChains = new Map<string, Promise<unknown>>();

  function withSurfaceLock<T>(surfaceId: string, fn: () => Promise<T>): Promise<T> {
    return chainOnKey(surfaceOpChains, surfaceId, fn);
  }

  // Surfaces with an auto-retry already scheduled. Synchronous check-and-set:
  // overlapping refreshSession calls (15s timer, discovery, resume) each hold
  // their own in-memory copy of the session, so the retryCount guard alone
  // can't stop two of them from BOTH scheduling a spawn for the same failure.
  const pendingAutoRetries = new Set<string>();

  // ── Root / session-dir helpers ─────────────────────────────────────────────

  async function ensureRoot() {
    await ensureDir(root);
    return root;
  }

  async function listSessionDirs() {
    const resolvedRoot = await ensureRoot();
    const entries = await readdir(resolvedRoot, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(resolvedRoot, entry.name));
  }

  async function loadSession(sessionDir: string) {
    return readJsonFile<OwnedSessionRecord>(metadataPath(sessionDir));
  }

  async function saveSession(session: OwnedSessionRecord) {
    session.updatedAt = nowIso();
    await writeJsonFile(metadataPath(session.sessionDir), session);
  }

  async function findSession(surfaceId: string) {
    for (const sessionDir of await listSessionDirs()) {
      const filePath = metadataPath(sessionDir);
      if (!(await pathExists(filePath))) continue;
      const session = await loadSession(sessionDir);
      if (session.surfaceId === surfaceId) {
        return session;
      }
    }
    return null;
  }

  // #1293 — read-only lookup for an ARCHIVED session (its dir was moved to the
  // `<root>-archive` tree). The transcript data survives the archive, but the run
  // artifact paths were stored absolute under the ACTIVE dir, so the `rename`
  // orphaned them — rebase each onto the archived dir so a done agent's lane
  // stays reviewable ("the transcript stays for review"). Never used for live
  // ops; the caller skips refresh/save for archived sessions.
  async function findArchivedSession(surfaceId: string): Promise<OwnedSessionRecord | null> {
    const archivePath = await archivedSessionPathForSurfaceId(root, surfaceId, surfacePrefix);
    if (!archivePath) return null;
    if (!(await pathExists(metadataPath(archivePath)))) return null;
    const session = await loadSession(archivePath);
    const rebaseRun = <T extends { stdoutPath: string; stderrPath: string }>(run: T): T => ({
      ...run,
      stdoutPath: path.join(archivePath, RUNS_DIR, path.basename(run.stdoutPath)),
      stderrPath: path.join(archivePath, RUNS_DIR, path.basename(run.stderrPath)),
    });
    return {
      ...session,
      sessionDir: archivePath,
      recentRuns: session.recentRuns.map(rebaseRun),
      activeRun: session.activeRun ? rebaseRun(session.activeRun) : session.activeRun,
    };
  }

  async function archiveSession(surfaceId: string): Promise<OwnedArchiveResponse> {
    const session = await findSession(surfaceId);
    if (!session) {
      const archivePath = await archivedSessionPathForSurfaceId(root, surfaceId, surfacePrefix);
      if (archivePath) {
        invalidateFleetCache();
        return { archived: true, archivePath, note: 'Session already archived.' };
      }
      return { archived: false, note: 'Session was not found.' };
    }

    const result = await archiveOwnedSessionDir(root, session);
    if (result.archived) {
      invalidateFleetCache();
    }
    return result;
  }

  // ── Run artifacts ──────────────────────────────────────────────────────────

  // #1484 — the event-loop saturation fix. refreshSession / collectTailEntries
  // / packet reviews call this for EVERY recent run on EVERY poll (inventory,
  // status snapshots, the packet tab's transcript tail), and a streaming
  // Codex run's stdout grows to megabytes — so three streaming lanes meant
  // re-reading and re-JSON.parsing the same multi-MB logs dozens of times a
  // second on the shared loop (10.9s wall for a trivial 500ms poll, threads
  // parked in cvwait). Run logs are APPEND-ONLY: cache the parse keyed on the
  // files' (size, mtime) and skip both the read and the parse when nothing
  // changed — which is almost every poll, and permanently for finished runs.
  const runArtifactCache = new Map<string, {
    stdoutKey: string;
    stderrKey: string;
    /** null = raw exceeded RAW_RETENTION_MAX_BYTES; re-read from disk on hit (F19). */
    stdoutRaw: string | null;
    stderrRaw: string | null;
    parsed: ParsedRunLog;
  }>();
  const RUN_ARTIFACT_CACHE_MAX = 48;

  async function statKey(filePath: string): Promise<string> {
    try {
      const info = await stat(filePath);
      return `${info.size}:${info.mtimeMs}`;
    } catch {
      return 'absent';
    }
  }

  // Adversarial F19 — retain raw log text only under this cap. The cache's
  // win is skipping the re-PARSE; pinning up to 48 multi-MB raw stdout
  // buffers was a new hundreds-of-MB retention risk. Oversized runs keep the
  // parsed result cached and re-read raw from disk on hit (cheap vs parse).
  const RAW_RETENTION_MAX_BYTES = 2 * 1024 * 1024;

  async function readRunArtifacts(run: OwnedRunRecord) {
    const [stdoutKey, stderrKey] = await Promise.all([
      statKey(run.stdoutPath),
      statKey(run.stderrPath),
    ]);
    const cached = runArtifactCache.get(run.id);
    if (cached && cached.stdoutKey === stdoutKey && cached.stderrKey === stderrKey) {
      // Refresh recency for the LRU eviction below.
      runArtifactCache.delete(run.id);
      runArtifactCache.set(run.id, cached);
      if (cached.stdoutRaw !== null && cached.stderrRaw !== null) {
        return { stdoutRaw: cached.stdoutRaw, stderrRaw: cached.stderrRaw, parsed: cached.parsed };
      }
      // Oversized run: parse stays cached, raw re-reads from disk.
      const [rereadStdout, rereadStderr] = await Promise.all([
        cached.stdoutRaw ?? (stdoutKey === 'absent' ? '' : readFile(run.stdoutPath, 'utf8').catch(() => '')),
        cached.stderrRaw ?? (stderrKey === 'absent' ? '' : readFile(run.stderrPath, 'utf8').catch(() => '')),
      ]);
      return { stdoutRaw: rereadStdout, stderrRaw: rereadStderr, parsed: cached.parsed };
    }

    const [stdoutRaw, stderrRaw] = await Promise.all([
      stdoutKey === 'absent' ? '' : readFile(run.stdoutPath, 'utf8').catch(() => ''),
      stderrKey === 'absent' ? '' : readFile(run.stderrPath, 'utf8').catch(() => ''),
    ]);

    const withinRawCap = stdoutRaw.length + stderrRaw.length <= RAW_RETENTION_MAX_BYTES;
    const entry = {
      stdoutKey,
      stderrKey,
      stdoutRaw: withinRawCap ? stdoutRaw : null,
      stderrRaw: withinRawCap ? stderrRaw : null,
      parsed: adapter.parseRunLog(stdoutRaw, run),
    };
    runArtifactCache.set(run.id, entry);
    while (runArtifactCache.size > RUN_ARTIFACT_CACHE_MAX) {
      const oldest = runArtifactCache.keys().next().value;
      if (oldest === undefined) break;
      runArtifactCache.delete(oldest);
    }
    return { stdoutRaw, stderrRaw, parsed: entry.parsed };
  }

  async function readOwnedRunStdout(run: OwnedRunRecord): Promise<string> {
    const [stdoutRaw, stderrRaw] = await Promise.all([
      pathExists(run.stdoutPath).then((exists) => (exists ? readFile(run.stdoutPath, 'utf8').catch(() => '') : '')),
      pathExists(run.stderrPath).then((exists) => (exists ? readFile(run.stderrPath, 'utf8').catch(() => '') : '')),
    ]);
    // Fallback chain inspects both streams since Gemini's rate-limit signal
    // lives on stderr (TerminalQuotaError) while other runtimes may put it
    // on stdout.
    return `${stdoutRaw}\n${stderrRaw}`;
  }

  async function readCostLine(run: OwnedRunRecord): Promise<string | undefined> {
    const raw = await readOwnedRunStdout(run).catch(() => '');
    return raw.split(/\r?\n/)
      .reverse()
      .map((line) => line.trim())
      .find((line) => /\$\d+(?:\.\d+)?/.test(line) || /\bcost\b/i.test(line));
  }

  async function recordDetachedChildExit(
    surfaceId: string,
    runId: string,
    stderrPath: string,
    outcome: OwnedChildExitOutcome,
  ) {
    const stderrTail = await readAbnormalStderrTail(stderrPath, outcome);
    const childExit = stderrTail ? { ...outcome, stderrTail } : outcome;

    let finishedClean = false;
    await withSurfaceLock(surfaceId, async () => {
      const current = await findSession(surfaceId);
      if (!current) return;
      let dirty = false;
      const finishedAt = nowIso();
      const applyExit = (run: OwnedRunRecord): OwnedRunRecord => {
        if (run.id !== runId) return run;
        dirty = true;
        const nextOutcome = run.outcome === 'interrupted'
          ? 'interrupted'
          : childExit.classification === 'clean-exit'
            ? 'finished'
            : 'failed';
        if (nextOutcome === 'finished') finishedClean = true;
        return {
          ...run,
          childExit,
          finishedAt: run.finishedAt ?? finishedAt,
          outcome: nextOutcome,
        };
      };

      current.recentRuns = current.recentRuns.map(applyExit);
      if (current.activeRun?.id === runId) {
        current.activeRun = undefined;
        dirty = true;
      }
      if (dirty) await saveSession(current);
    });
    invalidateFleetCache();

    // #1523 — push completion instead of waiting for a poll. This is the one
    // moment the runtime authoritatively knows the run ended clean; without
    // the push, the lane transition raced the session_lost grace, the orphan
    // sweep, and the 45s/90s salvage nets — and usually lost (field data:
    // silent_exit_work_present / zombie_reap_salvaged were the COMMON endings
    // for completed work). The supervisor's completionReported guard makes
    // this idempotent with the poller path. Fire-and-forget: on failure the
    // existing nets still catch the lane.
    if (finishedClean) {
      void notifySupervisorOfCleanExit(surfaceId);
    }
  }

  async function notifySupervisorOfCleanExit(surfaceId: string): Promise<void> {
    try {
      const [{ resolvePortInfo }, { getOrCreateWsToken }] = await Promise.all([
        import('@/lib/panel/api-port'),
        import('@/lib/ws-auth'),
      ]);
      const { wsPort } = resolvePortInfo();
      await fetch(`http://127.0.0.1:${wsPort}/supervisor/completed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getOrCreateWsToken()}` },
        body: JSON.stringify({ surfaceId }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (err) {
      console.warn(`[owned-session] completion push failed for ${surfaceId} (salvage nets remain):`, err);
    }
  }

  async function emitRuntimeFallbackNotification(
    session: OwnedSessionRecord,
    fromModel: string,
    toModel: string,
    reason: string,
  ) {
    try {
      const { publishRealtimeMutation } = await import('@/lib/realtime/publisher');
      publishRealtimeMutation({
        mutation: {
          mutationId: `runtime-fallback-${session.surfaceId}-${Date.now()}`,
          source: 'server',
          action: 'runtime-fallback',
          status: 'completed',
          runtime: runtimeId as OrchestratorRuntime,
          surfaceId: session.surfaceId,
          sessionKey: session.surfaceId,
          note: `${runtimeId} ${fromModel} → ${toModel}: ${reason}`,
          createdAt: nowIso(),
          settledAt: nowIso(),
          fromModel,
          toModel,
          reason,
        } as unknown as Parameters<typeof publishRealtimeMutation>[0]['mutation'],
        refreshTargets: ['global', 'sessionHistory'],
        sessionKeys: [session.surfaceId],
        fresh: true,
      });
    } catch (err) {
      console.error(`[owned-store] emitRuntimeFallbackNotification failed:`, err);
    }
  }

  // ── Session refresh (outcome reconciliation + auto-retry) ─────────────────

  async function refreshSession(session: OwnedSessionRecord) {
    let dirty = false;

    for (const run of session.recentRuns) {
      const { stderrRaw, parsed } = await readRunArtifacts(run);

      if (!session.threadId && parsed.threadId) {
        session.threadId = parsed.threadId;
        dirty = true;
      }

      const runAlive = await isOwnedRunAlive(run);
      if (runAlive) {
        if (run.outcome !== 'running') {
          run.outcome = 'running';
          dirty = true;
        }
        continue;
      }

      const nextOutcome = deriveRunOutcome(run, parsed, stderrRaw, stderrNoise);
      if (run.outcome !== nextOutcome) {
        run.outcome = nextOutcome;
        dirty = true;
      }
      if (!run.finishedAt) {
        run.finishedAt = nowIso();
        dirty = true;
      }
    }

    if (session.activeRun && !(await isOwnedRunAlive(session.activeRun))) {
      session.activeRun = undefined;
      dirty = true;
    }

    if (dirty) {
      await saveSession(session);
    }

    // Auto-retry: if the latest run just failed and autoRetry is enabled,
    // retry once after `retryDelayMs`. Only fires when the failure is fresh
    // (<60s) so stale failures don't cascade on app reload. Allows up to
    // `MAX_AUTO_RETRIES` attempts when the adapter provides a
    // `chooseRetryModel` fallback (Gemini walks the model cascade on quota).
    const retryBudget = adapter.chooseRetryModel ? MAX_AUTO_RETRIES : 1;
    if (session.autoRetry && (session.retryCount ?? 0) < retryBudget) {
      const latestFailedRun = session.recentRuns.find((r) => r.outcome === 'failed');
      if (latestFailedRun && !session.activeRun) {
        const failAge = latestFailedRun.finishedAt
          ? Date.now() - new Date(latestFailedRun.finishedAt).getTime()
          : Infinity;
        if (failAge < AUTO_RETRY_FRESHNESS_MS && !pendingAutoRetries.has(session.surfaceId)) {
          // Claim the retry slot BEFORE any await — this is what makes the
          // double-spawn impossible (two concurrent workers on one worktree).
          pendingAutoRetries.add(session.surfaceId);
          // Give the adapter a chance to swap the session's model before the
          // retry (Gemini cascade). When a new model is picked, broadcast a
          // `runtime_fallback` notification so the chat pane can render a
          // pill explaining the switch.
          if (adapter.chooseRetryModel) {
            try {
              const failedRaw = await readOwnedRunStdout(latestFailedRun);
              const decision = adapter.chooseRetryModel({
                failedRunRaw: failedRaw,
                currentModel: session.model,
              });
              if (decision && decision.nextModel !== session.model) {
                const fromModel = session.model ?? '(default)';
                session.model = decision.nextModel;
                dirty = true;
                console.log(`[owned-store] ${runtimeId} fallback ${fromModel} → ${decision.nextModel} (${decision.reason})`);
                void emitRuntimeFallbackNotification(session, fromModel, decision.nextModel, decision.reason);
              }
            } catch (hookErr) {
              console.error(`[owned-store] chooseRetryModel hook failed for ${session.surfaceId}:`, hookErr);
            }
          }
          session.retryCount = (session.retryCount ?? 0) + 1;
          await saveSession(session);
          console.log(`[owned-store] Auto-retrying ${runtimeId} session ${session.surfaceId} after failure (attempt ${session.retryCount})`);
          setTimeout(async () => {
            try {
              await withSurfaceLock(session.surfaceId, () =>
                spawnOwnedRun(session, session.latestPrompt, session.threadId ? 'resume' : 'launch'));
              invalidateFleetCache();
            } catch (err) {
              console.error(`[owned-store] Auto-retry failed for ${session.surfaceId}:`, err);
            } finally {
              pendingAutoRetries.delete(session.surfaceId);
            }
          }, retryDelayMs);
        }
      }
    }

    return session;
  }

  // ── Lifecycle derivation ───────────────────────────────────────────────────

  function latestFinishedRun(session: OwnedSessionRecord) {
    return [...session.recentRuns]
      .filter((run) => run.outcome !== 'running')
      .sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt))[0];
  }

  function latestRun(session: OwnedSessionRecord) {
    return [...session.recentRuns].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  }

  function deriveLifecycle(session: OwnedSessionRecord, activeRunOverride?: boolean): RuntimeSurfaceLifecycle {
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

  function reviewDisposition(session: OwnedSessionRecord): OwnedReviewDisposition {
    return session.reviewDisposition ?? 'watching';
  }

  // ── Surface / status building ──────────────────────────────────────────────

  function buildRuntimeSurface(session: OwnedSessionRecord, running: boolean): RuntimeSurfaceSummary {
    const lifecycle = deriveLifecycle(session);
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
        ? `IDE-owned ${adapter.squadShortName} registry • active pid ${session.activeRun?.pid ?? 'unknown'}${lastOutcomeLabel}`
        : `IDE-owned ${adapter.squadShortName} registry • ${lifecycleAvailabilityLabel(lifecycle.availability)}${lastOutcomeLabel}`,
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

  function deriveOwnedStatus(session: OwnedSessionRecord): AgentSummary['status'] {
    const lifecycle = deriveLifecycle(session);
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

  function buildCurrentTask(session: OwnedSessionRecord, running: boolean) {
    const lifecycle = deriveLifecycle(session);
    if (running) {
      return `IDE-launched ${adapter.squadShortName} run active. ${session.latestSummary}`;
    }
    if (lifecycle.availability === 'awaiting-thread') {
      return `IDE-owned ${adapter.squadShortName} session launched and waiting for its first thread id. ${session.latestSummary}`;
    }
    if (reviewDisposition(session) === 'resolved') {
      return `Operator marked this owned result resolved. Keep watching only if new evidence appears. ${session.latestSummary}`;
    }
    if (lifecycle.lastOutcome === 'interrupted') {
      return `IDE-owned ${adapter.squadShortName} session is ready for resume after an interrupted run. ${session.latestSummary}`;
    }
    if (lifecycle.lastOutcome === 'failed') {
      return `IDE-owned ${adapter.squadShortName} session is ready for a corrective follow-up after a failed run. ${session.latestSummary}`;
    }
    if (session.threadId) {
      return `IDE-owned ${adapter.squadShortName} session ready for the next input via resume. ${session.latestSummary}`;
    }
    return `IDE-owned ${adapter.squadShortName} session is idle. ${session.latestSummary}`;
  }

  function formatChildExit(outcome: OwnedChildExitOutcome | undefined) {
    if (!outcome) return '';
    const signal = outcome.signal ? ` signal ${outcome.signal}` : '';
    const code = outcome.code === null ? '' : ` code ${outcome.code}`;
    const stderrTail = outcome.stderrTail ? ` stderrTail=${compactText(outcome.stderrTail, 180)}` : '';
    return ` • child ${outcome.classification}${code}${signal}${stderrTail}`;
  }

  // ── Spawn / launch / resume / interrupt ────────────────────────────────────

  async function spawnOwnedRun(session: OwnedSessionRecord, prompt: string, mode: OwnedRunMode) {
    await ensureDir(path.join(session.sessionDir, RUNS_DIR));

    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const stdoutPath = path.join(session.sessionDir, RUNS_DIR, `${runId}.jsonl`);
    const stderrPath = path.join(session.sessionDir, RUNS_DIR, `${runId}.stderr.log`);

    let args: string[];
    let stdinPayload: string | null = null;
    if (mode === 'launch') {
      args = adapter.launchArgs({ cwd: session.repoPath, prompt, model: session.model, effort: session.effort });
      stdinPayload = adapter.launchStdin?.({ cwd: session.repoPath, prompt, model: session.model, effort: session.effort }) ?? null;
    } else {
      const built = adapter.resumeArgs({ threadId: session.threadId ?? '', prompt, model: session.model });
      if (!built) {
        throw new Error(`Resume is not supported by the ${humanLabel} runtime adapter.`);
      }
      args = built;
    }

    // Resolve CLI binary via the shared resolver (honours env overrides, nvm,
    // volta, Finder-launched Tauri env, etc.). Caches across calls.
    let binary: string;
    try {
      binary = (await resolveCli({
        runtimeId,
        binaryName: adapter.binaryName,
        envOverride: adapter.binaryEnvOverride,
        extraEnvOverrides: adapter.binaryExtraEnvOverrides,
      })).path;
    } catch (error) {
      if (!(error instanceof CliNotFoundError)) {
        // Don't silently degrade to a bare binary name — log why resolution
        // failed so a PATH-stripped spawn failure is diagnosable.
        console.error(`[owned-session] ${runtimeId} CLI resolution failed, falling back to bare "${adapter.binaryName}":`, error);
        binary = adapter.binaryName;
      } else {
        const run = await stageMissingCliRun({
          runtimeId,
          binaryName: adapter.binaryName,
          humanLabel,
          envOverride: adapter.binaryEnvOverride,
          triedPaths: error.triedPaths,
          session,
          runId,
          mode,
          prompt,
          stdoutPath,
          stderrPath,
          finishedAt: nowIso(),
        });
        await saveSession(session);
        return run;
      }
    }

    let pid = 0;
    let terminalSessionName: string | undefined;
    let detachMode: 'bridge' | 'detached' = 'bridge';
    let detachedChild: ChildProcess | undefined;
    let runPersisted = false;
    let pendingDetachedExit: OwnedChildExitOutcome | undefined;

    const bridgeSessionName = tmuxSessionName(runtimeId, runId);
    const cliCmd = [binary, ...args].map(quoteShellArg).join(' ');
    const shellCmd = `${stdinPayload ? `printf %s ${quoteShellArg(stdinPayload)} | ` : ''}${cliCmd} | tee '${stdoutPath}' 2>'${stderrPath}'`;

    // Adapter-supplied env augmentation. Returned keys override anything
    // already in the parent process env on the spawned child.
    const adapterEnv = adapter.extraSpawnEnv ? adapter.extraSpawnEnv() : {};
    const spawnEnv = {
      ...adapterEnv,
      // The CLIs are `#!/usr/bin/env node` shims — guarantee the server's own
      // node runtime is on the child PATH (nvm-only machines have none, #1551).
      PATH: pathWithNodeRuntime(),
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      // Mark the dispatched worker's identity. Its `o8` CLI sends this as the
      // Bearer, so governance routes (e.g. POST /api/panel/approvals) can deny a
      // worker resolving its own approval — the CRIT-1 moat. The operator webview
      // + orchestrator MCP never carry it. (SECURITY_AUDIT_2026-07-02 §CRIT-1.)
      O8_WORKER_TOKEN: getOrCreateLocalWorkerToken(),
    };

    await ensureDispatchBackendReady(runtimeId, mode);

    // #4 — crash-survivable workers (default ON since the 0.1.512 kill-test). When
    // enabled we skip the ws-server PTY bridge and spawn the worker detached
    // (setsid+unref) so it outlives a ws-server restart / full app crash, transcript
    // streaming to stdoutPath; boot re-binds the survivor. Set
    // O8_CRASH_SURVIVABLE_WORKERS=0 to fall back to the bridge. The detached block
    // below is the SAME code that has always been the bridge's fallback.
    if (!crashSurvivableWorkersEnabled()) {
      try {
        const result = await spawnBridgeTerminalSession({
          sessionName: bridgeSessionName,
          shellCommand: shellCmd,
          cwd: session.repoPath,
          env: spawnEnv,
        });
        terminalSessionName = result.sessionName;
        pid = typeof result.pid === 'number' ? result.pid : 0;
      } catch {
        // bridge spawn failed — fall through to detached spawn
      }
    }

    if (!terminalSessionName) {
      const stdoutFd = openSync(stdoutPath, 'a');
      const stderrFd = openSync(stderrPath, 'a');
      try {
        // Workers run at reduced CPU priority (nice +10). A 10-worker dispatch
        // burst at full priority starved the o8 node server — API latency
        // ballooned, the webview's connection pool saturated, and the dashboard
        // crashed mid-scoring-run (2026-07-04). Workers are batch compute; the
        // operator's UI is interactive and always wins the scheduler.
        const child = process.platform === 'win32'
          ? spawn(binary, args, {
              cwd: session.repoPath,
              detached: true,
              stdio: [stdinPayload ? 'pipe' : 'ignore', stdoutFd, stderrFd],
              env: { ...process.env, ...spawnEnv },
            })
          : spawn('nice', ['-n', '10', binary, ...args], {
              cwd: session.repoPath,
              detached: true,
              stdio: [stdinPayload ? 'pipe' : 'ignore', stdoutFd, stderrFd],
              // Detached fallback inherits process.env then layers adapter env +
              // FORCE_COLOR/NO_COLOR, matching the bridge path's semantics.
              env: { ...process.env, ...spawnEnv },
            });
        detachedChild = child;
        observeChildExit(child, (childExit) => {
          if (!runPersisted) {
            pendingDetachedExit = childExit;
            return;
          }
          void recordDetachedChildExit(session.surfaceId, runId, stderrPath, childExit).catch((err) => {
            console.warn(`[owned-store] ${runtimeId} child-exit recording failed for ${runId}:`, err);
          });
        });
        if (stdinPayload && child.stdin) {
          child.stdin.end(stdinPayload, 'utf8');
        }
        child.unref();
        pid = child.pid ?? 0;
        detachMode = 'detached';
      } finally {
        closeSync(stdoutFd);
        closeSync(stderrFd);
      }
    }

    const run: OwnedRunRecord = {
      id: runId,
      mode,
      prompt,
      startedAt: nowIso(),
      pid,
      stdoutPath,
      stderrPath,
      outcome: 'running',
      tmuxSession: terminalSessionName,
      detachMode,
    };

    session.latestPrompt = prompt;
    session.latestSummary = compactText(prompt, 140) || session.latestSummary;
    session.reviewDisposition = 'watching';
    session.reviewDispositionUpdatedAt = nowIso();
    session.activeRun = run;
    session.recentRuns = [run, ...session.recentRuns].slice(0, 16);
    await saveSession(session);
    runPersisted = true;
    if (detachedChild && pendingDetachedExit) {
      void recordDetachedChildExit(session.surfaceId, run.id, run.stderrPath, pendingDetachedExit).catch((err) => {
        console.warn(`[owned-store] ${runtimeId} child-exit recording failed for ${run.id}:`, err);
      });
    }
    return run;
  }

  async function launch(request: OwnedLaunchRequest): Promise<OwnedLaunchResponse> {
    const prompt = request.prompt.trim();
    if (!prompt) {
      throw new Error('prompt is required');
    }

    const repoPath = await validateWorkspace(request.cwd);
    const repo = await resolveRepoContext(repoPath);
    const id = `${sessionIdPrefix}${Date.now()}-${randomUUID().slice(0, 8)}`;
    const sessionDir = path.join(await ensureRoot(), id);
    await ensureDir(sessionDir);

    const session: OwnedSessionRecord = {
      surfaceId: `${surfacePrefix}${id}`,
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
      reviewDisposition: 'watching',
      reviewDispositionUpdatedAt: nowIso(),
      recentRuns: [],
    };

    await saveSession(session);
    const run = await spawnOwnedRun(session, prompt, 'launch');
    invalidateFleetCache();
    void sweepRecentlyOrphanedActiveRuns().catch(() => {});
    const failedBeforeLaunch = run.outcome === 'failed';

    return {
      ok: true,
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
    let session = await findSession(surfaceId);
    let coldRestored = false;

    // #1524 — cold resume. The session dir being archived (reset cleanup,
    // silent-exit sweep, restart) used to make resume throw "session was not
    // found" — killing steer (escalation layer 3) in exactly the scenarios
    // that produce escalations. The runtime's own rollout lives outside our
    // tree (e.g. ~/.codex/sessions), so when the archived metadata still holds
    // a threadId the session is fully resumable: restore the dir and resume
    // the persisted thread, clearly marked cold so cost expectations stay
    // honest.
    if (!session) {
      const archived = await findArchivedSession(surfaceId);
      if (archived?.threadId) {
        const restore = await restoreArchivedOwnedSessionDir(root, surfaceId, surfacePrefix);
        if (restore.restored) {
          session = await findSession(surfaceId);
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

    // Adversarial F13 — a restored dir whose resume then FAILS must not stay
    // in the active tree: discovery has no retirement gate, so an unbound
    // restored dir re-spawns as a phantom lane (the #1292 multiply class).
    // Roll the restore back whenever the cold resume doesn't complete.
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
      await refreshSession(session);

      if (session.activeRun && isPidAlive(session.activeRun.pid)) {
        throw new Error(`This owned ${adapter.squadShortName} session still has an active run. Wait for it to settle or interrupt it first.`);
      }
      if (!session.threadId) {
        throw new Error(`This owned ${adapter.squadShortName} session does not have a thread id yet, so resume is not available.`);
      }

      const run = await spawnOwnedRun(session, prompt.trim(), 'resume');
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
    const session = await findSession(surfaceId);
    if (!session) {
      throw new Error(`Owned ${adapter.squadShortName} session was not found.`);
    }
    await refreshSession(session);

    if (!session.activeRun || !isPidAlive(session.activeRun.pid)) {
      return { interrupted: false, note: `No active owned ${adapter.squadShortName} run was in flight.` };
    }

    try {
      if (session.activeRun.tmuxSession) {
        await signalBridgeTerminalSession(session.activeRun.tmuxSession, 'SIGINT');
      } else {
        // PID-reuse guard: `kill(-pid)` signals the whole group. If our run
        // already exited and the OS recycled the id, the group leader is an
        // innocent process — verify the command line still looks like our
        // spawned shell (it embeds the runtime binary name) before signaling.
        const cmd = await pidCommandLine(session.activeRun.pid);
        if (cmd && cmd.includes(adapter.binaryName)) {
          process.kill(-session.activeRun.pid, 'SIGINT');
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
      await saveSession(session);
      invalidateFleetCache();
      return { interrupted: true, note: `Interrupt sent to the active IDE-owned ${adapter.squadShortName} run.` };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : `Unable to interrupt the owned ${adapter.squadShortName} run.`);
    }
  }

  async function markActiveRunOrphaned(session: OwnedSessionRecord, reason: string) {
    const activeRun = session.activeRun;
    if (!activeRun) return false;
    const costLine = await readCostLine(activeRun);
    const orphanedAt = nowIso();
    if (await isOwnedRunAlive(activeRun)) {
      try {
        if (activeRun.tmuxSession) {
          await signalBridgeTerminalSession(activeRun.tmuxSession, 'SIGINT');
        } else {
          const cmd = await pidCommandLine(activeRun.pid);
          if (cmd && cmd.includes(adapter.binaryName)) {
            process.kill(-activeRun.pid, 'SIGINT');
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
    await saveSession(session);
    console.warn(`[owned-store] Orphaned ${runtimeId} session ${session.surfaceId}: ${reason}${costLine ? ` cost=${costLine}` : ''}`);
    return true;
  }

  function setReviewDisposition(surfaceId: string, disposition: OwnedReviewDisposition) {
    return withSurfaceLock(surfaceId, () => setReviewDispositionInner(surfaceId, disposition));
  }

  async function setReviewDispositionInner(surfaceId: string, disposition: OwnedReviewDisposition) {
    const session = await findSession(surfaceId);
    if (!session) {
      throw new Error(`Owned ${adapter.squadShortName} session was not found.`);
    }

    session.reviewDisposition = disposition;
    session.reviewDispositionUpdatedAt = nowIso();
    await saveSession(session);
    invalidateFleetCache();

    return {
      disposition,
      note: disposition === 'resolved'
        ? 'Marked this owned result resolved. It stays visible, but no longer needs active attention unless new evidence appears.'
        : 'Switched this owned result back to keep-watching mode.',
    };
  }

  // ── Telemetry / tail / review ──────────────────────────────────────────────

  async function getTelemetrySources(surfaceId: string) {
    // #1502 — archived fallback, same rule as getRuntimeTail (#1293). Headless
    // workers complete-and-archive fast, so by the time the packet transcript
    // is read the session is usually archived; without this fallback every
    // headless worker's transcript (and lastTranscriptAt) read as empty. The
    // run-log JSONL survives archiving — read it where it lives.
    const activeSession = await findSession(surfaceId);
    const session = activeSession ?? await findArchivedSession(surfaceId);
    if (!session) {
      return null;
    }

    // refreshSession reconciles run liveness and MUTATES metadata — it must
    // never run against an archived dir (see getRuntimeTail's rule).
    if (activeSession) {
      await refreshSession(session);
    }

    return {
      threadId: session.threadId,
      stdoutPaths: [...session.recentRuns]
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .map((run) => run.stdoutPath),
    };
  }

  async function collectTailEntries(session: OwnedSessionRecord) {
    const runs = [...session.recentRuns].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const entries: OwnedTailEntry[] = [];
    const groups: OwnedTailGroup[] = [];
    let discoveredThreadId = session.threadId;

    for (const run of runs) {
      const { parsed, stderrRaw } = await readRunArtifacts(run);
      if (!parsed.entries.length) continue;

      const outcome = deriveRunOutcome(run, parsed, stderrRaw, stderrNoise);
      discoveredThreadId = discoveredThreadId ?? parsed.threadId;
      entries.push(...parsed.entries);
      groups.push({
        id: run.id,
        title: `${run.mode === 'launch' ? launchGroupLabel : resumeGroupLabel} • ${outcome}`,
        mode: run.mode,
        outcome,
        // Packet prompts carry the full scope (800-line rule, self-review gate,
        // commit discipline, preservation contracts). Keep enough headroom for
        // the entire body so the PacketHeaderCard can render it expanded.
        prompt: compactText(run.prompt, 8000),
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        startedAtLabel: formatClock(run.startedAt),
        finishedAtLabel: formatClock(run.finishedAt),
        summary: outcome === 'interrupted'
          ? `Interrupted before ${adapter.squadShortName} completed the turn.`
          : outcome === 'failed'
            ? 'Run ended without a clean turn completion.'
            : outcome === 'running'
              ? 'Run is still in flight.'
              : 'Run completed and the session can continue from here.',
        entries: parsed.entries,
      });
    }

    return {
      entries: entries.slice(-24),
      groups: groups.slice(-8),
      threadId: discoveredThreadId,
    };
  }

  async function getRuntimeTail(surfaceId: string) {
    const activeSession = await findSession(surfaceId);
    // #1293 — fall back to the archived session so a retired (archived/merged/
    // reset) lane still serves its transcript read-only instead of 500-ing with
    // "runtime surface was not found" (which rendered an empty archived tab).
    const session = activeSession ?? await findArchivedSession(surfaceId);
    if (!session) {
      throw new Error(`Owned ${adapter.squadShortName} runtime surface was not found.`);
    }

    // Archived sessions have no live process — refreshSession reconciles run
    // liveness, MUTATES the metadata, and can auto-retry/spawn a run, so it must
    // never run against an archived dir. Read the persisted transcript only.
    if (activeSession) {
      await refreshSession(session);
      const tail = await collectTailEntries(session);
      if (!session.threadId && tail.threadId) {
        session.threadId = tail.threadId;
        await saveSession(session);
      }
      return {
        surface: buildRuntimeSurface(session, Boolean(session.activeRun)),
        entries: tail.entries,
        groups: tail.groups,
      };
    }

    const tail = await collectTailEntries(session);
    return {
      surface: buildRuntimeSurface(session, false),
      entries: tail.entries,
      groups: tail.groups,
    };
  }

  function buildReviewActions(packet: Pick<RuntimeReviewPacket, 'dirty' | 'changedFiles' | 'lastRun' | 'reviewDisposition'>) {
    const actions = [] as string[];

    if (packet.lastRun?.outcome === 'running') {
      actions.push('Watch the active run', 'Interrupt if it drifts');
      return actions;
    }

    if (packet.reviewDisposition === 'resolved') {
      actions.push('Keep watching for new evidence');
    }

    if (packet.dirty) {
      actions.push('Review current repo delta', 'Open desktop diff context');
    }

    if (packet.lastRun?.outcome === 'failed') {
      actions.push('Resume with correction context', 'Inspect failing command evidence');
    } else if (packet.lastRun?.outcome === 'interrupted') {
      actions.push('Resume from the interrupted state');
    } else if (packet.lastRun?.outcome === 'finished') {
      actions.push('Decide whether the result is good enough', 'Resume with a bounded follow-up if needed');
    }

    if (!actions.length) {
      actions.push('Review the latest run evidence');
    }

    return actions.slice(0, 4);
  }

  function buildReviewNotes(session: OwnedSessionRecord, dirty: boolean) {
    const latest = latestRun(session);
    const notes = [
      'Current repo delta is shown live from git and is not yet isolated per run when multiple sessions touch the same repo.',
    ];

    if (!dirty) {
      notes.push('The repo is currently clean, so this run may have been exploratory, purely read-only, or already reconciled.');
    }

    if (!session.threadId) {
      notes.push(`This owned surface is still waiting for its first persistent ${adapter.squadShortName} thread id before resume becomes available.`);
    }
    if (latest?.childExit && latest.childExit.classification !== 'clean-exit') {
      notes.push(`Worker child exit: ${latest.childExit.classification}; code=${latest.childExit.code ?? 'null'}; signal=${latest.childExit.signal ?? 'null'}${latest.childExit.stderrTail ? `; stderrTail=${compactText(latest.childExit.stderrTail, 500)}` : ''}.`);
    }

    return notes;
  }

  async function getReviewPacket(surfaceId: string): Promise<RuntimeReviewPacket> {
    const session = await findSession(surfaceId);
    if (!session) {
      throw new Error(`Owned ${adapter.squadShortName} review packet was not found.`);
    }

    await refreshSession(session);
    const repoReview = await getRuntimeRepoReview(session.repoPath);
    const lastRun = latestRun(session);
    const lastRunArtifacts = lastRun ? await readRunArtifacts(lastRun) : null;
    const lastRunOutcome = lastRun && lastRunArtifacts
      ? deriveRunOutcome(lastRun, lastRunArtifacts.parsed, lastRunArtifacts.stderrRaw, stderrNoise)
      : undefined;
    const lastRunEvidence = lastRunArtifacts && lastRun && adapter.parseRunEvidence
      ? adapter.parseRunEvidence(lastRunArtifacts.stdoutRaw, lastRun, lastRunOutcome ?? lastRun.outcome)
      : null;
    const runtimeSurface = buildRuntimeSurface(session, Boolean(session.activeRun));
    const linkedWorktree = await getWorktreeManager(session.repoPath).list()
      .then((worktrees) => worktrees.find((worktree) => worktree.sessionKey === session.surfaceId) ?? null)
      .catch(() => null);

    const packet: RuntimeReviewPacket = {
      surfaceId: session.surfaceId,
      runtime: runtimeId,
      title: session.title,
      summary: runtimeSurface.lifecycle?.summary ?? session.latestSummary,
      repoPath: shortHome(session.repoPath),
      repoSlug: session.repoSlug,
      branch: repoReview.branch ?? session.branch,
      head: repoReview.head ?? session.head,
      dirty: repoReview.dirty,
      diffStat: repoReview.diffStat,
      changedFiles: repoReview.changedFiles,
      recentCommits: repoReview.recentCommits,
      reviewDisposition: reviewDisposition(session),
      reviewDispositionUpdatedAt: session.reviewDispositionUpdatedAt,
      reviewDispositionUpdatedAtLabel: formatClock(session.reviewDispositionUpdatedAt),
      worktree: linkedWorktree ? {
        id: linkedWorktree.id,
        path: linkedWorktree.path,
        branch: linkedWorktree.branch,
        baseBranch: linkedWorktree.baseBranch,
        status: linkedWorktree.status,
        dirtyFiles: linkedWorktree.dirtyFiles,
      } : null,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            mode: lastRun.mode,
            outcome: lastRunOutcome ?? lastRun.outcome,
            prompt: compactText(lastRun.prompt, 260),
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt,
            startedAtLabel: formatClock(lastRun.startedAt),
            finishedAtLabel: formatClock(lastRun.finishedAt),
            assistantSummary: lastRunEvidence?.assistantSummary,
            commands: lastRunEvidence?.commands ?? [],
          }
        : undefined,
      nextActions: [],
      notes: buildReviewNotes(session, repoReview.dirty),
    };

    packet.nextActions = buildReviewActions(packet);
    return packet;
  }

  // ── Fleet additions (TTL cache + inflight dedupe) ──────────────────────────

  async function computeFleetAdditions(): Promise<OwnedFleetAdditions> {
    const sessionDirs = await listSessionDirs();
    if (!sessionDirs.length) {
      return {
        agents: [],
        squads: [],
        events: [],
        artifacts: [],
        ownedThreadIds: [],
      };
    }

    // Refresh every session in parallel (#1293). A serial scan paid the
    // per-session liveness probe (up to a 3s tmux-bridge timeout per dead run)
    // one after another, so a flood of dead/resumable records — e.g. dozens of
    // corpses left by a failed best-of-N fan-out — pushed the whole inventory
    // build past its 3.5s hard timeout and wedged the observable in "warming"
    // permanently. Parallel caps the wall-time at roughly one probe regardless
    // of how many corpses pile up. One unreadable dir drops to null instead of
    // rejecting the whole scan.
    const settled = await Promise.all(
      sessionDirs.map(async (sessionDir): Promise<OwnedSessionRecord | null> => {
        try {
          const filePath = metadataPath(sessionDir);
          if (!(await pathExists(filePath))) return null;
          const session = await loadSession(sessionDir);
          await refreshSession(session);
          return session;
        } catch {
          return null;
        }
      }),
    );
    const allSessions: OwnedSessionRecord[] = settled.filter(
      (session): session is OwnedSessionRecord => session !== null,
    );

    // Filter out stale sessions: no active run + last activity > 24h ago.
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
        const status = deriveOwnedStatus(session);
        const runtimeSurface = buildRuntimeSurface(session, running);
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
          currentTask: buildCurrentTask(session, running),
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

    const promise = computeFleetAdditions();

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

  // ── Periodic outcome refresh ───────────────────────────────────────────────
  // Forces getFleetAdditions({fresh:true}) every 15s so sessions whose CLI
  // exited between user-driven refreshes stop sitting at outcome:'running'
  // forever. Cheap — readdir on the runtime root + pid/tmux probes only for
  // sessions that the fleet code considers running. One timer per runtime,
  // guarded against HMR via a global symbol so Next dev hot-reload doesn't
  // leak timers across store factory re-imports.
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

  // #1292/#1460 — startup orphan sweep: archive any owned-session dir NOT bound
  // to an active lane and past the in-flight window. Active runs older than the
  // caller's grace are interrupted and marked orphaned before archive. The dominant case
  // is handled by reset archiving its own dir — this is the self-healing belt-
  // and-suspenders for orphans from OTHER paths (supervisor relaunch, crashes).
  // Adversarial F6 — a session's "last activity" must include metadata
  // updates (a cold-resume restore stamps updatedAt), or a just-restored
  // session with an old run reads as stale and gets re-archived out from
  // under the in-flight resume.
  function sessionLastActivityMs(session: OwnedSessionRecord): number {
    const latest = latestRun(session);
    const candidates = [latest?.finishedAt, latest?.startedAt, session.updatedAt]
      .map((value) => (value ? new Date(value).getTime() : Number.NaN))
      .filter((value) => Number.isFinite(value));
    return candidates.length > 0 ? Math.max(...candidates) : 0;
  }

  async function sweepOrphanedSessions(activeSurfaceIds: Set<string>, maxAgeMs: number): Promise<number> {
    let archived = 0;
    for (const sessionDir of await listSessionDirs()) {
      try {
        if (!(await pathExists(metadataPath(sessionDir)))) continue;
        const session = await loadSession(sessionDir);
        if (activeSurfaceIds.has(session.surfaceId)) continue; // bound to a live lane — keep
        if (Date.now() - sessionLastActivityMs(session) < maxAgeMs) continue; // recently active — keep
        // F6 — archive under the surface lock so an in-flight resume (which
        // holds the same lock) serializes with the sweep, and re-validate
        // freshness under the lock before touching anything.
        const didArchive = await withSurfaceLock(session.surfaceId, async () => {
          if (!(await pathExists(metadataPath(sessionDir)))) return false;
          const current = await loadSession(sessionDir);
          if (activeSurfaceIds.has(current.surfaceId)) return false;
          if (Date.now() - sessionLastActivityMs(current) < maxAgeMs) return false;
          if (current.activeRun) {
            await markActiveRunOrphaned(current, `No lane referenced this owned ${runtimeId} session within ${Math.round(maxAgeMs / 1000)}s of launch.`);
          }
          const result = await archiveOwnedSessionDir(root, current);
          return result.archived;
        });
        if (didArchive) archived += 1;
      } catch { /* best-effort per dir — never block startup */ }
    }
    if (archived > 0) invalidateFleetCache();
    return archived;
  }

  async function sweepRecentlyOrphanedActiveRuns(): Promise<number> {
    const { listActiveLanes } = await import('@/lib/lane/registry');
    const activeSurfaceIds = new Set(
      listActiveLanes()
        .map((lane) => lane.sessionKey?.trim())
        .filter((key): key is string => Boolean(key)),
    );
    return sweepOrphanedSessions(activeSurfaceIds, ACTIVE_ORPHAN_GRACE_MS);
  }

  void sweepRecentlyOrphanedActiveRuns().catch(() => {});

  // ── Assembled store ────────────────────────────────────────────────────────

  return {
    runtimeId,
    surfaceIdPrefix: surfacePrefix,
    launch,
    resume,
    interrupt,
    getRuntimeTail,
    getReviewPacket,
    getFleetAdditions,
    archiveSession,
    sweepOrphanedSessions,
    getTelemetrySources,
    setReviewDisposition,
    invalidateFleetCache,
  };
}
