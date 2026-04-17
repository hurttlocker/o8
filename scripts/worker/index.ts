import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { cloneRepoForRun, pushRemoteBranch } from './clone-repo';
import { EventStream } from './event-stream';
import { runCodex } from './run-codex';

interface WorkerCliOptions {
  o8Url: string;
  token: string;
  workspaceDir: string;
  pollIntervalMs: number;
}

function parseArgs(argv: string[]): WorkerCliOptions {
  let o8Url = '';
  let token = '';
  let workspaceDir = path.join(homedir(), '.o8', 'worker');
  let pollIntervalMs = 5_000;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--o8-url' && typeof next === 'string') { o8Url = next; i += 1; }
    else if (arg === '--token' && typeof next === 'string') { token = next; i += 1; }
    else if (arg === '--workspace-dir' && typeof next === 'string') { workspaceDir = next; i += 1; }
    else if (arg === '--poll-interval-ms' && typeof next === 'string') {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed >= 1_000) pollIntervalMs = parsed;
      i += 1;
    }
  }

  if (!o8Url) throw new Error('[worker] --o8-url is required (the o8 base URL including port)');
  if (!token) {
    token = process.env.O8_WORKER_TOKEN ?? '';
    if (!token) throw new Error('[worker] --token is required or set O8_WORKER_TOKEN');
  }

  return { o8Url, token, workspaceDir, pollIntervalMs };
}

interface LaunchEvent {
  type: 'launch';
  payload: {
    runId: string;
    repoUrl: string;
    baseRef: string;
    remoteBranch: string;
    packetPrompt: string;
    modelHint?: string;
  };
}

interface InterruptEvent {
  type: 'interrupt';
  payload: { runId: string };
}

type WorkerEvent = LaunchEvent | InterruptEvent;

function isWorkerEvent(value: unknown): value is WorkerEvent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.type === 'string'
    && (candidate.type === 'launch' || candidate.type === 'interrupt');
}

async function handleLaunch(event: LaunchEvent, stream: EventStream, opts: WorkerCliOptions) {
  const { payload } = event;
  const runDir = path.join(opts.workspaceDir, payload.runId);
  console.log(`[worker] launch ${payload.runId} → ${runDir}`);

  let cloneDir = '';
  try {
    cloneDir = await cloneRepoForRun({
      repoUrl: payload.repoUrl,
      baseRef: payload.baseRef,
      remoteBranch: payload.remoteBranch,
      workDir: runDir,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[worker] clone failed for ${payload.runId}: ${message}`);
    await stream.postEvent(payload.runId, 'errored', { message });
    return;
  }

  await stream.postEvent(payload.runId, 'progress', { text: `Cloned repo to ${cloneDir}` });

  const result = await runCodex({
    cwd: cloneDir,
    runId: payload.runId,
    packetPrompt: payload.packetPrompt,
    modelHint: payload.modelHint,
    stream,
  });

  if (result.exitCode !== 0) {
    await stream.postEvent(payload.runId, 'errored', {
      message: `codex exited with code ${result.exitCode}`,
      stderrTail: result.stderrTail.slice(-2_000),
    });
    return;
  }

  try {
    const sha = await pushRemoteBranch(cloneDir, payload.remoteBranch);
    await stream.postEvent(payload.runId, 'branch_pushed', { branch: payload.remoteBranch, sha });
    await stream.postEvent(payload.runId, 'completed', { result: `branch ${payload.remoteBranch} pushed at ${sha}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[worker] push failed for ${payload.runId}: ${message}`);
    await stream.postEvent(payload.runId, 'errored', { message });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const stream = new EventStream({ o8Url: opts.o8Url, token: opts.token });

  console.log(`[worker] online — polling ${opts.o8Url}/api/worker/poll every ${opts.pollIntervalMs}ms`);

  const shouldExit = { value: false };
  const shutdown = () => { shouldExit.value = true; };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (!shouldExit.value) {
    const event = await stream.pollOnce();
    if (!event) {
      await new Promise<void>((resolve) => setTimeout(resolve, opts.pollIntervalMs));
      continue;
    }
    if (!isWorkerEvent(event)) {
      console.warn(`[worker] ignoring unknown event shape`);
      continue;
    }
    if (event.type === 'launch') {
      await handleLaunch(event, stream, opts);
    } else {
      console.log(`[worker] interrupt requested for ${event.payload.runId} — v1 does not cancel in-flight codex runs`);
    }
  }

  console.log('[worker] shutdown complete');
  process.exit(0);
}

void main().catch((error) => {
  console.error('[worker] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
