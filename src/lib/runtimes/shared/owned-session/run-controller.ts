import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getOrCreateLocalWorkerToken } from '@/lib/auth/worker-token';
import { mintPacketWorkerToken } from '@/lib/auth/packet-worker-token';
import { recordLaneEvent } from '@/lib/lane/events';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { spawnBridgeTerminalSession } from '@/lib/runtime/pty-bridge';
import { ensureDispatchBackendReady } from '@/lib/runtimes/shared/dispatch-readiness';
import { CliNotFoundError, resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { tmuxSessionName } from '@/lib/terminal/tmux';
import { pathWithNodeRuntime } from '@/lib/util/node-on-path';

import { crashSurvivableWorkersEnabled } from './crash-survival';
import { observeChildExit, readAbnormalStderrTail } from './exit-outcome';
import { detectSandboxDenial, sandboxDenialOperatorMessage } from './sandbox-denial';
import {
  AUTO_RETRY_FRESHNESS_MS,
  MAX_AUTO_RETRIES,
  RUNS_DIR,
  compactText,
  deriveRunOutcome,
  ensureDir,
  isOwnedRunAlive,
  nowIso,
  pathExists,
} from './helpers';
import { stageMissingCliRun } from './missing-cli';
import {
  prepareWorkerSandbox,
  SandboxUnavailableError,
  workerSandboxEnabled,
} from './sandbox';
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
  invalidateFleetCache,
}: {
  adapter: OwnedRuntimeAdapter;
  runtimeId: string;
  humanLabel: string;
  retryDelayMs: number;
  stderrNoise: RegExp[];
  io: OwnedSessionIo;
  withSurfaceLock: <T>(surfaceId: string, fn: () => Promise<T>) => Promise<T>;
  invalidateFleetCache: () => void;
}): OwnedRunController {
  const pendingAutoRetries = new Set<string>();
  const runArtifactCache = new Map<string, {
    stdoutKey: string;
    stderrKey: string;
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
    const cached = runArtifactCache.get(run.id);
    if (cached && cached.stdoutKey === stdoutKey && cached.stderrKey === stderrKey) {
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
    await withSurfaceLock(surfaceId, async () => {
      const current = await io.findSession(surfaceId);
      if (!current) return;
      laneId = current.laneId;
      model = current.model;
      latestPrompt = current.latestPrompt;
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

    if (laneId && exitedRun) {
      const artifacts = await readRunArtifacts(exitedRun).catch(() => null);
      const stderr = compactText(artifacts?.stderrRaw || childExit.stderrTail || '', 4_000);
      const rawFailure = `${artifacts?.stdoutRaw ?? ''}\n${artifacts?.stderrRaw ?? childExit.stderrTail ?? ''}`;
      try {
        recordLaneEvent(laneId, 'runtime_process_exit', 'system', {
          runtime: runtimeId,
          surfaceId,
          runId,
          exitCode: childExit.code,
          signal: childExit.signal,
          classification: childExit.classification,
          stderr,
          completedTurn: artifacts?.parsed.completedTurn ?? false,
        });
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

  async function refreshSession(session: OwnedSessionRecord) {
    let dirty = false;

    for (const run of session.recentRuns) {
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
        const denial = detectSandboxDenial(`${stdoutRaw}\n${stderrRaw}`);
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

    if (session.activeRun && !(await isOwnedRunAlive(session.activeRun))) {
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

    let spawnBinary = binary;
    let spawnArgs = args;
    const sandboxEnvExtra: Record<string, string> = {};
    const sandboxEnabled = workerSandboxEnabled();
    if (sandboxEnabled) {
      try {
        const prepared = await prepareWorkerSandbox({
          runId,
          profileDir: path.join(session.sessionDir, RUNS_DIR),
          cwd: session.repoPath,
          repoPath: session.repoPath,
          binary,
          args,
        });
        spawnBinary = prepared.binary;
        spawnArgs = prepared.args;
        const { apiPort, wsPort } = resolvePortInfo();
        sandboxEnvExtra.O8_API_PORT = String(apiPort);
        sandboxEnvExtra.O8_WS_PORT = String(wsPort);
      } catch (error) {
        const message = error instanceof SandboxUnavailableError
          ? `${humanLabel} dispatch refused: worker sandbox is enabled (O8_WORKER_SANDBOX) but could not be provided — ${error.message}`
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
        session.recentRuns = [failedRun, ...session.recentRuns].slice(0, 16);
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
    const cliCmd = [spawnBinary, ...spawnArgs].map(quoteShellArg).join(' ');
    const shellCmd = `${stdinPayload ? `printf %s ${quoteShellArg(stdinPayload)} | ` : ''}${cliCmd} | tee '${stdoutPath}' 2>'${stderrPath}'`;
    const adapterEnv = adapter.extraSpawnEnv ? adapter.extraSpawnEnv() : {};
    const workerToken = session.packetId
      ? mintPacketWorkerToken(session.packetId)
      : getOrCreateLocalWorkerToken();
    const spawnEnv = {
      ...adapterEnv,
      PATH: pathWithNodeRuntime(),
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      // Workers must never pop an OS browser: dev servers (CRA, storybook)
      // auto-open via BROWSER, and `o8 run` mirrors this env into its pane
      // (report J4FHM2). 'none' is the CRA disable convention; tools that
      // treat BROWSER as a launch binary fail to exec it, same net effect.
      BROWSER: 'none',
      O8_WORKER_TOKEN: workerToken,
      ...(session.packetId ? { O8_WORKER_PACKET_ID: session.packetId } : {}),
      ...sandboxEnvExtra,
    };

    await ensureDispatchBackendReady(runtimeId, mode);

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
        const child = process.platform === 'win32'
          ? spawn(winLaunch.command, winLaunch.args, {
              windowsHide: true,
              cwd: session.repoPath,
              detached: true,
              stdio: [stdinPayload ? 'pipe' : 'ignore', stdoutFd, stderrFd],
              env: { ...process.env, ...spawnEnv },
            })
          : spawn('nice', ['-n', '10', spawnBinary, ...spawnArgs], {
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

    const run: OwnedRunRecord = {
      id: runId,
      mode,
      prompt,
      startedAt: nowIso(),
      pid,
      stdoutPath,
      stderrPath,
      outcome: 'running',
      sandboxed: sandboxEnabled,
      tmuxSession: terminalSessionName,
      detachMode,
    };

    session.latestPrompt = prompt;
    session.latestSummary = compactText(prompt, 140) || session.latestSummary;
    session.reviewDisposition = 'watching';
    session.reviewDispositionUpdatedAt = nowIso();
    session.activeRun = run;
    session.recentRuns = [run, ...session.recentRuns].slice(0, 16);
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
    spawnOwnedRun,
  };
}
