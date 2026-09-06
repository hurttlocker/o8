import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getOrCreateLocalWorkerToken } from '@/lib/auth/worker-token';
import {
  bindPacketWorkerTokenProcess,
  mintPacketWorkerToken,
} from '@/lib/auth/packet-worker-token';
import { recordLaneEvent } from '@/lib/lane/events';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { spawnBridgeTerminalSession } from '@/lib/runtime/pty-bridge';
import { ensureDispatchBackendReady } from '@/lib/runtimes/shared/dispatch-readiness';
import { CliNotFoundError, resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { guardedWorkspaceInvocation } from '@/lib/worktree/materialization-execution';
import { tmuxSessionName } from '@/lib/terminal/tmux';
import { pathWithNodeRuntime } from '@/lib/util/node-on-path';

import { crashSurvivableWorkersEnabled } from './crash-survival';
import { observeChildExit, readAbnormalStderrTail } from './exit-outcome';
import { prepareOwnedLaunchArgs } from './launch-args';
import { detectSandboxDenial, detectRunSandboxDenial, sandboxDenialOperatorMessage } from './sandbox-denial';
import {
  AUTO_RETRY_FRESHNESS_MS,
  MAX_AUTO_RETRIES,
  RUNS_DIR,
  compactText,
  deriveRunOutcome,
  ensureDir,
  isOwnedRunAlive,
  nowIso,
  ownedProcessExitPayload,
  pathExists,
} from './helpers';
import { stageMissingCliRun } from './missing-cli';
import { prependOwnedRun } from './run-ledger';
import { probeOwnedRunMarker, resolveSpawnedProcessGroupId } from './run-process-proof';
import { assertOwnedWorkspaceSpawnAvailable, type OwnedWorkspaceSpawnGuard } from './workspace-spawn-guard';
import {
  prepareWorkerSandbox,
  SandboxUnavailableError,
  workerSandboxEnabled,
} from './sandbox';
import { resolveReadOnlySandboxPlan } from './work-mode';
import { preparedRuntimeStateSandboxPolicy } from './runtime-state-sandbox';
import type { OwnedSessionIo } from './session-io';
import type {
  OwnedChildExitOutcome,
  ParsedRunLog,
  OwnedRunMode,
  OwnedRunRecord,
  OwnedRuntimeAdapter,
  OwnedSessionRecord,
} from './types';

export interface OwnedRunController {
  readRunArtifacts(run: OwnedRunRecord): Promise<{
    stdoutRaw: string;
    stderrRaw: string;
    parsed: ReturnType<OwnedRuntimeAdapter['parseRunLog']>;
  }>;
  readCostLine(run: OwnedRunRecord): Promise<string | undefined>;
  refreshSession(session: OwnedSessionRecord): Promise<OwnedSessionRecord>;
  reconcilePreparedRuns(session: OwnedSessionRecord): Promise<OwnedSessionRecord>;
  spawnOwnedRun(
    session: OwnedSessionRecord,
    prompt: string,
    mode: OwnedRunMode,
  ): Promise<OwnedRunRecord>;
}

export function createOwnedRunController({
  adapter,
  runtimeId,
  humanLabel,
  retryDelayMs,
  stderrNoise,
  io,
  withSurfaceLock,
  workspaceSpawnGuard,
  invalidateFleetCache,
}: {
  adapter: OwnedRuntimeAdapter;
  runtimeId: string;
  humanLabel: string;
  retryDelayMs: number;
  stderrNoise: RegExp[];
  io: OwnedSessionIo;
  withSurfaceLock: <T>(surfaceId: string, fn: () => Promise<T>) => Promise<T>;
  workspaceSpawnGuard: OwnedWorkspaceSpawnGuard;
  invalidateFleetCache: () => void;
}): OwnedRunController {
  const pendingAutoRetries = new Set<string>();
  const runArtifactCache = new Map<string, {
    key: string;
    /** null = raw exceeded RAW_RETENTION_MAX_BYTES; re-read from disk on hit. */
    stdoutRaw: string | null;
    stderrRaw: string | null;
    parsed: ParsedRunLog;
  }>();
  const RUN_ARTIFACT_CACHE_MAX = 48;
  const RAW_RETENTION_MAX_BYTES = 2 * 1024 * 1024;
  function recordSandboxDenialEvent(
    laneId: string,
    surfaceId: string,
    runId: string,
    denial: NonNullable<OwnedRunRecord['sandboxDenial']>,
  ): void {
    const message = sandboxDenialOperatorMessage(runtimeId, denial);
    recordLaneEvent(laneId, 'sandbox_denied', 'system', {
      runtime: runtimeId,
      surfaceId,
      runId,
      operation: denial.operation,
      resource: denial.resource,
      denialLine: denial.line,
      message,
    });
  }

  function quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  async function statKey(filePath: string): Promise<string> {
    try {
      const info = await stat(filePath);
      return `${info.size}:${info.mtimeMs}`;
    } catch {
      return 'absent';
    }
  }

  async function readRunArtifacts(run: OwnedRunRecord) {
    const [stdoutKey, stderrKey] = await Promise.all([
      statKey(run.stdoutPath),
      statKey(run.stderrPath),
    ]);
    const key = JSON.stringify([
      stdoutKey, stderrKey, run.outcome, run.finishedAt, run.interruptRequestedAt, run.childExit,
    ]);
    const cached = runArtifactCache.get(run.id);
    if (cached?.key === key) {
      runArtifactCache.delete(run.id);
      runArtifactCache.set(run.id, cached);
      if (cached.stdoutRaw !== null && cached.stderrRaw !== null) {
        return { stdoutRaw: cached.stdoutRaw, stderrRaw: cached.stderrRaw, parsed: cached.parsed };
      }
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
      key,
      stdoutRaw: withinRawCap ? stdoutRaw : null,
      stderrRaw: withinRawCap ? stderrRaw : null,
      parsed: adapter.parseRunLog(
        stdoutRaw,
        run,
        stdoutKey === 'absent' ? undefined
          : new Date(Number(stdoutKey.slice(stdoutKey.indexOf(':') + 1))).toISOString(),
      ),
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
    let exitedRun: OwnedRunRecord | null = null;
    let laneId: string | undefined;
    let model: string | undefined;
    let latestPrompt = '';
    let sandboxDenial: OwnedRunRecord['sandboxDenial'];
    let artifacts: Awaited<ReturnType<typeof readRunArtifacts>> | null = null;
    await withSurfaceLock(surfaceId, async () => {
      const current = await io.findSession(surfaceId);
      if (!current) return;
      laneId = current.laneId;
      model = current.model;
      latestPrompt = current.latestPrompt;
      const currentRun = current.recentRuns.find((run) => run.id === runId);
      artifacts = currentRun ? await readRunArtifacts({ ...currentRun, childExit }).catch(() => null) : null;
      let dirty = false;
      const finishedAt = nowIso();
      const applyExit = (run: OwnedRunRecord): OwnedRunRecord => {
        if (run.id !== runId) return run;
        dirty = true;
        const nextOutcome = run.outcome === 'interrupted'
          ? 'interrupted'
          : artifacts?.parsed.outcome === 'failed'
            ? 'failed'
          : childExit.classification === 'clean-exit'
            ? 'finished'
            : 'failed';
        if (nextOutcome === 'finished') finishedClean = true;
        const nextRun: OwnedRunRecord = {
          ...run,
          childExit,
          finishedAt: run.finishedAt ?? finishedAt,
          outcome: nextOutcome,
        };
        if (run.sandboxed && childExit.classification !== 'clean-exit') {
          sandboxDenial = detectSandboxDenial(childExit.stderrTail ?? '') ?? undefined;
          if (sandboxDenial) {
            nextRun.sandboxDenial = sandboxDenial;
            current.latestSummary = sandboxDenialOperatorMessage(runtimeId, sandboxDenial);
          }
        }
        exitedRun = nextRun;
        return nextRun;
      };

      current.recentRuns = current.recentRuns.map(applyExit);
      if (current.activeRun?.id === runId) {
        current.activeRun = undefined;
        dirty = true;
      }
      if (dirty) await io.saveSession(current);
    });
    invalidateFleetCache();

    const recordedRun = exitedRun as OwnedRunRecord | null;
    const recordedArtifacts = artifacts as Awaited<ReturnType<typeof readRunArtifacts>> | null;
    if (laneId && recordedRun) {
      const stderr = compactText(recordedArtifacts?.stderrRaw || childExit.stderrTail || '', 4_000);
      const rawFailure = `${recordedArtifacts?.stdoutRaw ?? ''}\n${recordedArtifacts?.stderrRaw ?? childExit.stderrTail ?? ''}`;
      try {
        recordLaneEvent(laneId, 'runtime_process_exit', 'system', ownedProcessExitPayload(
          runtimeId, surfaceId, recordedRun, childExit, recordedArtifacts?.parsed, stderr,
        ));
      } catch (error) {
        console.warn(`[owned-store] Failed to record runtime_process_exit for lane ${laneId}:`, error);
      }
      if (sandboxDenial) {
        try {
          recordSandboxDenialEvent(laneId, surfaceId, runId, sandboxDenial);
        } catch (error) {
          console.warn(`[owned-store] Failed to record sandbox_denied for lane ${laneId}:`, error);
        }
      } else if (!finishedClean) {
        try {
          const { handleWorkerRuntimeFailure } = await import('@/lib/dispatch/worker-quota-fallback');
          await handleWorkerRuntimeFailure({
            laneId,
            runtime: runtimeId,
            model,
            surfaceId,
            prompt: latestPrompt,
            rawFailure: compactText(rawFailure, 4_000),
          });
        } catch (error) {
          console.error(`[owned-store] Worker quota fallback handling failed for lane ${laneId}:`, error);
        }
      }
    }

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

  async function reconcilePreparedRuns(session: OwnedSessionRecord): Promise<OwnedSessionRecord> {
    let dirty = false;
    for (let index = 0; index < session.recentRuns.length; index += 1) {
      const run = session.recentRuns[index];
      if (!run || run.spawnState !== 'prepared') continue;
      const markerState = await probeOwnedRunMarker(run.processMarker);
      if (markerState !== 'clear') continue;
      const reconciled: OwnedRunRecord = {
        ...run,
        spawnState: 'reconciled_clear',
        outcome: 'failed',
        finishedAt: run.finishedAt ?? nowIso(),
      };
      session.recentRuns[index] = reconciled;
      if (session.activeRun?.id === run.id) session.activeRun = undefined;
      dirty = true;
    }
    if (dirty) await io.saveSession(session);
    return session;
  }

  async function refreshSession(session: OwnedSessionRecord) {
    let dirty = false;

    for (const run of session.recentRuns) {
      // A prepared journal is deliberately preserved until the binding path,
      // under the same surface lock as spawn, reconciles its durable marker.
      if (run.spawnState === 'prepared') continue;
      const { stdoutRaw, stderrRaw, parsed } = await readRunArtifacts(run);

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

      if (run.sandboxed && !run.sandboxDenial) {
        const denial = detectRunSandboxDenial(runtimeId, stdoutRaw, stderrRaw);
        if (denial) {
          run.sandboxDenial = denial;
          session.latestSummary = sandboxDenialOperatorMessage(runtimeId, denial);
          dirty = true;
          if (session.laneId) {
            try {
              recordSandboxDenialEvent(session.laneId, session.surfaceId, run.id, denial);
            } catch (error) {
              console.warn(`[owned-store] Failed to record sandbox_denied for lane ${session.laneId}:`, error);
            }
          }
        }
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

    if (session.activeRun
      && session.activeRun.spawnState !== 'prepared'
      && !(await isOwnedRunAlive(session.activeRun))) {
      session.activeRun = undefined;
      dirty = true;
    }

    if (dirty) {
      await io.saveSession(session);
    }

    const retryBudget = adapter.chooseRetryModel ? MAX_AUTO_RETRIES : 1;
    if (session.autoRetry && (session.retryCount ?? 0) < retryBudget) {
      const latestFailedRun = session.recentRuns.find((r) => r.outcome === 'failed');
      if (latestFailedRun && !latestFailedRun.sandboxDenial && !session.activeRun) {
        const failAge = latestFailedRun.finishedAt
          ? Date.now() - new Date(latestFailedRun.finishedAt).getTime()
          : Infinity;
        if (failAge < AUTO_RETRY_FRESHNESS_MS && !pendingAutoRetries.has(session.surfaceId)) {
          pendingAutoRetries.add(session.surfaceId);
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
          await io.saveSession(session);
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

  async function spawnOwnedRun(session: OwnedSessionRecord, prompt: string, mode: OwnedRunMode) {
    await ensureDir(path.join(session.sessionDir, RUNS_DIR));

    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const stdoutPath = path.join(session.sessionDir, RUNS_DIR, `${runId}.jsonl`);
    const stderrPath = path.join(session.sessionDir, RUNS_DIR, `${runId}.stderr.log`);

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
        await io.saveSession(session);
        return run;
      }
    }

    // A read-only packet FORCES the sandbox: `O8_WORKER_SANDBOX` is an opt-in
    // for normal packets and defaults off. See resolveReadOnlySandboxPlan.
    const readOnlySandbox = resolveReadOnlySandboxPlan(session);
    const sandboxEnabled = workerSandboxEnabled() || readOnlySandbox.enforced;
    const { args, stdinPayload, workerMcp } = await prepareOwnedLaunchArgs({
      adapter,
      session,
      runId,
      prompt,
      mode,
      sandboxEnabled,
      humanLabel,
    });
    // Prepare the exact isolated config root before Seatbelt is built.
    const adapterEnv: Record<string, string> = adapter.extraSpawnEnv
      ? await adapter.extraSpawnEnv(session)
      : {};
    const runtimeState = preparedRuntimeStateSandboxPolicy(adapter, session, adapterEnv);

    let spawnBinary = binary;
    let spawnArgs = args;
    const sandboxEnvExtra: Record<string, string> = {};
    if (sandboxEnabled) {
      try {
        const prepared = await prepareWorkerSandbox({
          runId,
          profileDir: path.join(session.sessionDir, RUNS_DIR),
          cwd: session.repoPath,
          repoPath: session.repoPath,
          binary,
          args,
          extraReadPaths: workerMcp.sandboxReadPaths,
          readBackingProjectConfig: runtimeId === 'codex',
          finalAllowReadPaths: workerMcp.configPath ? [workerMcp.configPath] : undefined,
          // Read-only: repo stays readable, kernel refuses every write. Deny
          // paths come from the SAME git probe prepareWorkerSandbox uses to
          // grant access, and it throws if that probe resolves nothing.
          enforceReadOnly: readOnlySandbox.enforced,
          finalAllowReadWritePaths: runtimeState.configHome
            ? [runtimeState.configHome]
            : undefined,
          finalImmutableWritePaths: runtimeState.immutablePaths,
        });
        spawnBinary = prepared.binary;
        spawnArgs = prepared.args;
        const { apiPort, wsPort } = resolvePortInfo();
        sandboxEnvExtra.O8_API_PORT = String(apiPort);
        sandboxEnvExtra.O8_WS_PORT = String(wsPort);
      } catch (error) {
        const why = readOnlySandbox.enforced
          ? 'this is a read-only packet, which requires an OS-enforced sandbox'
          : 'worker sandbox is enabled (O8_WORKER_SANDBOX)';
        const message = error instanceof SandboxUnavailableError
          ? `${humanLabel} dispatch refused: ${why} but it could not be provided — ${error.message}`
          : `${humanLabel} dispatch refused: worker sandbox preparation failed — ${(error as Error).message}`;
        console.error(`[owned-session] ${runtimeId} sandbox prep failed (fail-closed):`, error);
        await writeFile(stderrPath, `${message}\n`, 'utf8').catch(() => {});
        const failedRun: OwnedRunRecord = {
          id: runId,
          mode,
          prompt,
          startedAt: nowIso(),
          finishedAt: nowIso(),
          pid: 0,
          stdoutPath,
          stderrPath,
          outcome: 'failed',
        };
        session.latestPrompt = prompt;
        session.latestSummary = message;
        session.reviewDisposition = 'watching';
        session.reviewDispositionUpdatedAt = nowIso();
        session.activeRun = undefined;
        prependOwnedRun(session, failedRun);
        await io.saveSession(session);
        return failedRun;
      }
    }

    let pid = 0;
    let terminalSessionName: string | undefined;
    let detachMode: 'bridge' | 'detached' = 'bridge';
    let detachedChild: ChildProcess | undefined;
    let runPersisted = false;
    let pendingDetachedExit: OwnedChildExitOutcome | undefined;

    const bridgeSessionName = tmuxSessionName(runtimeId, runId);
    const workerToken = session.packetId
      ? mintPacketWorkerToken(session.packetId, { processMarker: runId })
      : getOrCreateLocalWorkerToken();
    const spawnEnv = {
      ...adapterEnv,
      // Some coding CLIs trust the inherited PWD instead of asking the OS for
      // the spawned process cwd. Keep both values aligned so a worker cannot
      // silently operate in the o8 server's own checkout.
      PWD: session.repoPath,
      PATH: pathWithNodeRuntime(),
      NODE_ENV: 'development' as const,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      // Workers must never pop an OS browser: dev servers (CRA, storybook)
      // auto-open via BROWSER, and `o8 run` mirrors this env into its pane
      // (report J4FHM2). 'none' is the CRA disable convention; tools that
      // treat BROWSER as a launch binary fail to exec it, same net effect.
      BROWSER: 'none',
      O8_WORKER_TOKEN: workerToken,
      O8_OWNED_RUN_MARKER: runId,
      ...(session.packetId ? { O8_WORKER_PACKET_ID: session.packetId } : {}),
      ...sandboxEnvExtra,
    };
    await ensureDispatchBackendReady(runtimeId, mode);
    const durableSession = await io.findSession(session.surfaceId);
    if (!durableSession) throw new Error('Owned session disappeared before its run could start.');
    Object.assign(session, durableSession);
    const spawnDecision = await assertOwnedWorkspaceSpawnAvailable({
      surfaceId: session.surfaceId, sessionPacketId: session.packetId ?? null, laneId: session.laneId ?? null,
      runtimeId, mode, binding: session.workspaceBinding ?? null, repoPath: session.repoPath,
    }, workspaceSpawnGuard);
    const materializationIdentity = spawnDecision.materializationIdentity ?? null;
    const bridgeLaunch = guardedWorkspaceInvocation(spawnBinary, spawnArgs, materializationIdentity);
    const cliCmd = [bridgeLaunch.command, ...bridgeLaunch.args].map(quoteShellArg).join(' ');
    const shellCmd = `${stdinPayload ? `printf %s ${quoteShellArg(stdinPayload)} | ` : ''}${cliCmd} | tee '${stdoutPath}' 2>'${stderrPath}'`;

    const preparedRun: OwnedRunRecord = {
      id: runId,
      mode,
      prompt,
      startedAt: nowIso(),
      pid: 0,
      commandIdentity: path.basename(spawnBinary),
      processMarker: runId,
      spawnState: 'prepared',
      stdoutPath,
      stderrPath,
      outcome: 'running',
      sandboxed: sandboxEnabled,
    };
    session.latestPrompt = prompt;
    session.latestSummary = compactText(prompt, 140) || session.latestSummary;
    session.reviewDisposition = 'watching';
    session.reviewDispositionUpdatedAt = nowIso();
    session.activeRun = preparedRun;
    prependOwnedRun(session, preparedRun);
    await io.saveSession(session);

    try {
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
          // bridge spawn failed; fall through to detached spawn
        }
      }

      if (!terminalSessionName) {
        const stdoutFd = openSync(stdoutPath, 'a');
        const stderrFd = openSync(stderrPath, 'a');
        try {
          // On Windows the resolved CLI is usually a `.cmd` shim (that is what npm
          // installs), and Node refuses to execute one without an interpreter —
          // it fails before a process exists, so the run dies in milliseconds with
          // pid 0 and an empty stderr, which reads like the agent instantly gave
          // up. cliInvocation is the identity for real executables. See #1758.
          const winLaunch = cliInvocation(spawnBinary, spawnArgs);
          const directLaunch = process.platform === 'win32'
            ? guardedWorkspaceInvocation(winLaunch.command, winLaunch.args, materializationIdentity)
            : guardedWorkspaceInvocation(
                '/usr/bin/nice',
                ['-n', '10', spawnBinary, ...spawnArgs],
                materializationIdentity,
              );
          const child = process.platform === 'win32'
            ? spawn(directLaunch.command, directLaunch.args, {
                windowsHide: true,
                cwd: session.repoPath,
                detached: true,
                stdio: [stdinPayload ? 'pipe' : 'ignore', stdoutFd, stderrFd],
                env: { ...process.env, ...spawnEnv },
              })
            : spawn(directLaunch.command, directLaunch.args, {
                windowsHide: true,
                cwd: session.repoPath,
                detached: true,
                stdio: [stdinPayload ? 'pipe' : 'ignore', stdoutFd, stderrFd],
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
    } catch (error) {
      // A synchronous failure can still follow an ambiguous bridge response,
      // so settle only when the durable marker scan proves no process exists.
      await reconcilePreparedRuns(session);
      throw error;
    }

    const processGroupId = process.platform !== 'win32' && detachMode === 'detached' && pid > 0
      ? pid
      : await resolveSpawnedProcessGroupId(pid);
    const run: OwnedRunRecord = {
      ...preparedRun,
      pid,
      processGroupId,
      spawnState: 'started',
      tmuxSession: terminalSessionName,
      detachMode,
    };

    if (session.packetId) {
      try {
        bindPacketWorkerTokenProcess(workerToken, {
          pid,
          processGroupId,
          processMarker: runId,
        });
      } catch (error) {
        console.warn(
          `[owned-session] ${runtimeId} worker credential process binding failed closed for lease mutations: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    session.activeRun = run;
    session.recentRuns = session.recentRuns.map((candidate) => candidate.id === run.id ? run : candidate);
    await io.saveSession(session);
    runPersisted = true;
    if (detachedChild && pendingDetachedExit) {
      void recordDetachedChildExit(session.surfaceId, run.id, run.stderrPath, pendingDetachedExit).catch((err) => {
        console.warn(`[owned-store] ${runtimeId} child-exit recording failed for ${run.id}:`, err);
      });
    }
    return run;
  }

  return {
    readRunArtifacts,
    readCostLine,
    refreshSession,
    reconcilePreparedRuns,
    spawnOwnedRun,
  };
}
