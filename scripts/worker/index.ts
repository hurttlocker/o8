import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { cloneRepoForRun, commitWorkerChanges, pushRemoteBranch } from './clone-repo';
import { EventStream, type CloudRemoteSource, type CloudWorkerControl, type CloudWorkerJob } from './event-stream';
import { startCodex, type RunningCodex } from './run-codex';
import { PersistentWorkerState } from './state';
import { startWorkspaceServices, type RunningWorkspaceServices } from './workspace-services';
import { startPreviewRelay } from './preview';
import { HeartbeatAuthorityExpired, renewServiceHeartbeat } from './service-heartbeat';

interface WorkerCliOptions {
  o8Url: string;
  workerKey: string;
  workspaceDir: string;
  pollIntervalMs: number;
  controlPollIntervalMs: number;
  workerId?: string;
}

function parseInterval(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : fallback;
}

export function parseArgs(argv: string[]): WorkerCliOptions {
  let o8Url = '';
  let workerKey = '';
  let workspaceDir = path.join(homedir(), '.o8', 'worker');
  let pollIntervalMs = 5_000;
  let controlPollIntervalMs = 5_000;
  let workerId: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--o8-url' && typeof next === 'string') { o8Url = next; i += 1; }
    else if (arg === '--worker-key' && typeof next === 'string') { workerKey = next; i += 1; }
    else if (arg === '--workspace-dir' && typeof next === 'string') { workspaceDir = next; i += 1; }
    else if (arg === '--worker-id' && typeof next === 'string') { workerId = next; i += 1; }
    else if (arg === '--poll-interval-ms') { pollIntervalMs = parseInterval(next, pollIntervalMs); i += 1; }
    else if (arg === '--control-poll-interval-ms') { controlPollIntervalMs = parseInterval(next, controlPollIntervalMs); i += 1; }
  }
  if (!o8Url) throw new Error('[worker] --o8-url is required');
  workerKey ||= process.env.O8_CLOUD_WORKER_KEY ?? '';
  if (!workerKey.startsWith('cwk_')) {
    throw new Error('[worker] --worker-key or O8_CLOUD_WORKER_KEY must contain a scoped cloud worker key');
  }
  return { o8Url, workerKey, workspaceDir, pollIntervalMs, controlPollIntervalMs, workerId };
}

function remoteSource(job: CloudWorkerJob): CloudRemoteSource {
  const source = job.launch.remoteSource;
  if (!source || typeof source.repoUrl !== 'string' || typeof source.baseSha !== 'string' || typeof source.branch !== 'string') {
    throw new Error('[worker] cloud job has no valid remote source');
  }
  return source;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/cwk_[a-z0-9]+/gi, 'cwk_[redacted]')
    .replace(/(https?:\/\/)[^@/\s]+@/gi, '$1[redacted]@');
}

async function reportFailure(stream: EventStream, job: CloudWorkerJob, error: unknown): Promise<void> {
  const message = safeMessage(error);
  console.error(`[worker] job ${job.id} failed: ${message}`);
  try {
    await stream.postEvent(job, 'errored', { message });
  } catch (eventError) {
    console.error(`[worker] job ${job.id} failure event could not be persisted: ${safeMessage(eventError)}`);
  }
}

async function handleLaunch(job: CloudWorkerJob, stream: EventStream, opts: WorkerCliOptions, shutdown: AbortSignal): Promise<void> {
  const operation = new AbortController();
  let codex: RunningCodex | null = null;
  let services: RunningWorkspaceServices | null = null;
  let stopPreview: (() => Promise<void>) | null = null;
  let abortControl: CloudWorkerControl | null = null;
  let monitorFailure: Error | null = null;
  let heartbeatTransportFailure: Error | null = null;
  const session = job.launch.remoteServiceSession;
  const serviceDeadline = session ? Date.parse(session.expiresAt) : Infinity;
  let deadlineExpired = false;
  let leaseExpiresAt = Math.min(Date.parse(job.leaseExpiresAt), serviceDeadline);
  if (!Number.isFinite(leaseExpiresAt)) {
    await reportFailure(stream, job, new Error('[worker] cloud job has no valid lease expiry'));
    return;
  }
  const stop = () => { operation.abort(); codex?.abort(); };
  shutdown.addEventListener('abort', stop, { once: true });
  if (shutdown.aborted) stop();
  const leaseMarginMs = Math.min(2_000, Math.max(10, Math.floor((leaseExpiresAt - Date.now()) / 5)));
  const watchdog = setInterval(() => {
    if (Date.now() >= serviceDeadline) { deadlineExpired = true; operation.abort(); codex?.abort(); return; }
    if (leaseExpiresAt === serviceDeadline) return;
    if (Date.now() < leaseExpiresAt - leaseMarginMs || monitorFailure || abortControl) return;
    monitorFailure = new Error(`[worker] ${heartbeatTransportFailure ? `heartbeat failed: ${safeMessage(heartbeatTransportFailure)}; ` : ''}lease renewal was not confirmed before expiry`);
    operation.abort();
    codex?.abort();
  }, 1_000);
  const monitorStop = new AbortController();
  const monitorSignal = AbortSignal.any([operation.signal, monitorStop.signal]);
  const monitor = async () => {
    if (monitorFailure || abortControl || monitorSignal.aborted) return;
    let stage = 'heartbeat';
    try {
      const renewed = session ? await renewServiceHeartbeat(stream, job, {
        signal: monitorSignal,
        confirmedUntil: leaseExpiresAt === serviceDeadline ? serviceDeadline : Math.min(leaseExpiresAt - leaseMarginMs, serviceDeadline),
        onTransportFailure: (error) => { heartbeatTransportFailure ??= error; },
      }) : await stream.postEvent(job, 'heartbeat', { status: 'running' }, monitorSignal);
      const nextExpiry = renewed ? Date.parse(renewed) : NaN;
      if (!Number.isFinite(nextExpiry) || nextExpiry <= Date.now()) throw new Error('[worker] heartbeat returned no valid lease expiry');
      leaseExpiresAt = Math.min(nextExpiry, serviceDeadline);
      heartbeatTransportFailure = null;
      stage = 'control poll';
      const control = await stream.pollControl(job, monitorSignal);
      if (control?.type === 'abort') {
        abortControl = control;
        operation.abort();
        codex?.abort();
      }
      // A one-shot Codex process cannot take a live steer. Completion keeps
      // the unacknowledged control and queues a durable follow-up instead.
    } catch (error) {
      // Aborting an in-flight renewal must not replace its watchdog cause.
      // Operator cancellation, the absolute deadline and process shutdown own
      // their existing cleanup paths rather than becoming monitoring failures.
      if (monitorSignal.aborted) return;
      if (error instanceof HeartbeatAuthorityExpired && Date.now() >= serviceDeadline) deadlineExpired = true;
      if (!monitorFailure && !abortControl && !deadlineExpired && !shutdown.aborted) {
        monitorFailure = new Error(`[worker] ${stage} failed: ${safeMessage(error)}`, { cause: error });
      }
      operation.abort();
      codex?.abort();
    }
  };
  await monitor();
  // One cycle at a time; hung requests cannot accumulate interval callbacks.
  const monitorChain = (async () => {
    while (!monitorSignal.aborted) {
      try { await delay(opts.controlPollIntervalMs, undefined, { signal: monitorSignal }); }
      catch { return; }
      await monitor();
    }
  })();
  let failure: unknown = null;
  try {
    if (!session && job.launch.workMode === 'read-only') throw new Error('[worker] read-only cloud jobs are unsupported by this worker');
    const source = remoteSource(job);
    if (abortControl || monitorFailure || shutdown.aborted) return;
    // A recovered lease must never reuse a checkout still owned by an older attempt.
    const runDir = path.join(opts.workspaceDir, `${job.id}-${randomUUID()}`);
    let checkout: { cacheHit: boolean; durationMs: number } | undefined;
    const cloneDir = await cloneRepoForRun({
      repoUrl: source.repoUrl, baseRef: source.baseSha, remoteBranch: source.branch,
      workDir: runDir, cacheDir: path.join(opts.workspaceDir, 'repository-cache'), signal: operation.signal,
      onCheckout: (receipt) => { checkout = receipt; },
    });
    if (abortControl || monitorFailure || shutdown.aborted) return;
    await stream.postEvent(job, 'chunk', {
      text: `Repository ready in ${((checkout?.durationMs ?? 0) / 1000).toFixed(1)}s${checkout?.cacheHit ? ' (cached base objects)' : ''}.`,
      checkout,
    }, operation.signal);

    services = await startWorkspaceServices({ cloneDir, job, stream, signal: operation.signal });
    if (services && job.launch.remotePreview) stopPreview = startPreviewRelay(job, stream, services, operation.signal);
    if (abortControl || monitorFailure || shutdown.aborted) return;

    if (session) {
      if (!services || !job.launch.remotePreview) throw new Error('[worker] service session has no preview service');
      while (!operation.signal.aborted) {
        const owned = await services.ownsPreview(job.launch.remotePreview);
        if (operation.signal.aborted) break;
        if (!owned) throw new Error('[worker] preview service lost health or socket ownership');
        await delay(1_000, undefined, { signal: operation.signal });
      }
      return;
    }
    codex = await startCodex({
      cwd: cloneDir,
      prompt: job.launch.prompt,
      model: job.launch.model,
      effort: job.launch.effort,
      onChunk: async (text) => { await stream.postEvent(job, 'chunk', { text }, operation.signal); },
    });
    if (abortControl || monitorFailure || shutdown.aborted) codex.abort();
    const result = await codex.result;
    if (abortControl || shutdown.aborted) return;
    if (monitorFailure) throw monitorFailure;
    if (result.aborted) throw new Error('[worker] Codex stopped before completion');
    if (result.exitCode !== 0) throw new Error(`[worker] codex exited with code ${result.exitCode}`);
    await stopPreview?.();
    stopPreview = null;
    const serviceStop = await services?.stop();
    services = null;
    if (serviceStop && !serviceStop.healthyUntilStop) {
      throw new Error('[worker] workspace service exited before task completion');
    }
    const files = await commitWorkerChanges(cloneDir, source.baseSha, operation.signal);
    if (files.length > 0) await stream.postEvent(job, 'diff', { files }, operation.signal);
    const sha = await pushRemoteBranch(cloneDir, source.branch, operation.signal);
    monitorStop.abort();
    await monitorChain;
    if (abortControl || shutdown.aborted) return;
    if (monitorFailure) throw monitorFailure;
    await stream.postEvent(job, 'completed', { result: `branch ${source.branch} pushed at ${sha}`, commitSha: sha }, operation.signal);
  } catch (error) {
    failure = error;
  } finally {
    operation.abort();
    monitorStop.abort();
    clearInterval(watchdog);
    shutdown.removeEventListener('abort', stop);
    await monitorChain;
    await stopPreview?.();
    await services?.stop().catch((error) => {
      console.error(`[worker] service cleanup failed: ${safeMessage(error)}`);
    });
    if (abortControl) {
      // Clone, Codex, or push has exited before the server marks cancellation.
      await stream.acknowledgeControl(job, abortControl).catch((error) => {
        console.error(`[worker] abort receipt failed: ${safeMessage(error)}`);
      });
    } else if (deadlineExpired) {
      // The coordinator durably cancels expired service sessions; never retry them.
      await stream.postEvent(job, 'heartbeat', {}).catch(() => {});
    } else if (shutdown.aborted) {
      // Process shutdown is not a task cancellation or an execution failure.
      // Stop renewing the lease; restart recovers it through the durable queue.
      console.log(`[worker] stopped job ${job.id}; its lease remains recoverable`);
    } else if (failure || monitorFailure) {
      const cause = failure instanceof Error && failure.name === 'AbortError'
        ? monitorFailure ?? failure : failure ?? monitorFailure;
      await reportFailure(stream, job, cause);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const state = await PersistentWorkerState.load(opts.workspaceDir, opts.workerId);
  const stream = new EventStream({ o8Url: opts.o8Url, workerKey: opts.workerKey, workerId: state.workerId });
  console.log(`[worker] online as ${state.workerId}; polling durable cloud queue`);
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const serviceJobs = new Set<Promise<void>>();
  try {
    while (!shutdown.signal.aborted) {
      try {
        const job = await stream.pollOnce(state.cursor, shutdown.signal);
        if (shutdown.signal.aborted) break;
        if (!job) { await delay(opts.pollIntervalMs, undefined, { signal: shutdown.signal }); continue; }
        await state.advanceCursor(job.cursor);
        if (job.launch.remoteServiceSession) {
          if (serviceJobs.size >= 2) { await reportFailure(stream, job, new Error('[worker] review preview capacity reached')); continue; }
          const running = handleLaunch(job, stream, opts, shutdown.signal)
            .catch((error) => reportFailure(stream, job, error)).finally(() => { serviceJobs.delete(running); });
          serviceJobs.add(running);
        } else {
          await handleLaunch(job, stream, opts, shutdown.signal);
        }
      } catch (error) {
        if (shutdown.signal.aborted) break;
        console.error(`[worker] poll failed: ${safeMessage(error)}`);
        await delay(opts.pollIntervalMs, undefined, { signal: shutdown.signal }).catch((waitError: unknown) => {
          if (!shutdown.signal.aborted) throw waitError;
        });
      }
    }
  } finally {
    shutdown.abort();
    await Promise.allSettled(serviceJobs);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  console.log('[worker] shutdown complete');
}

if (process.env.O8_WORKER_TEST !== '1') {
  void main().catch((error) => { console.error(`[worker] fatal: ${safeMessage(error)}`); process.exitCode = 1; });
}
