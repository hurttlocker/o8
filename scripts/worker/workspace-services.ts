import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import path from 'node:path';

import { parseWorkspaceManifest } from '../../src/lib/workspace/manifest/schema';
import { WORKSPACE_MANIFEST_FILENAME, type WorkspaceManifestService } from '../../src/lib/workspace/manifest/types';
import type { CloudWorkerJob, EventStream } from './event-stream';
import { ownsListeningPort } from './preview';
import { remotePreviewService, type RemotePreviewService } from '../../src/lib/cloud/preview-contract';

const SETUP_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const MAX_HEALTH_TIMEOUT_MS = 60_000;

function shell(command: string): [string, string[]] {
  return process.platform === 'win32'
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command]]
    : ['/bin/sh', ['-lc', command]];
}

function childEnvironment(extra: Record<string, string> = {}, port?: { env?: string; preferred: number }): NodeJS.ProcessEnv {
  const names = ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'TEMP', 'LANG', 'NODE_ENV'];
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'development' };
  for (const name of names) if (process.env[name]) environment[name] = process.env[name];
  Object.assign(environment, extra);
  if (port?.env) environment[port.env] = String(port.preferred);
  return environment;
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    return;
  }
  // The shell may have exited after starting a background descendant. Its
  // process group still belongs to this attempt and must be stopped.
  try { process.kill(-child.pid, signal); }
  catch { if (child.exitCode === null && child.signalCode === null) child.kill(signal); }
}

async function stopAndWait(child: ChildProcess): Promise<void> {
  signalTree(child, 'SIGTERM');
  if (child.exitCode !== null || child.signalCode !== null) {
    signalTree(child, 'SIGKILL');
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signalTree(child, 'SIGKILL');
      resolve();
    }, 3_000);
    child.once('close', () => { clearTimeout(timer); signalTree(child, 'SIGKILL'); resolve(); });
  });
}

async function runCommand(command: string, cwd: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (signal.aborted) throw new Error('Workspace command was cancelled.');
  const [program, args] = shell(command);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, {
      cwd, env: childEnvironment(), stdio: 'ignore', detached: process.platform !== 'win32',
    });
    let timedOut = false;
    let forceKill: ReturnType<typeof setTimeout> | null = null;
    const terminate = () => {
      signalTree(child, 'SIGTERM');
      forceKill ??= setTimeout(() => signalTree(child, 'SIGKILL'), 3_000);
    };
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const abort = () => terminate();
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      signal.removeEventListener('abort', abort);
      // Setup commands may background children. They are never allowed to
      // outlive this command; long-lived processes belong in services.
      signalTree(child, 'SIGKILL');
      if (signal.aborted) reject(new Error('Workspace command was cancelled.'));
      else if (timedOut) reject(new Error('Workspace command timed out.'));
      else if (code !== 0) reject(new Error(`Workspace command exited with code ${code}.`));
      else resolve();
    });
  });
}

async function exactCwd(root: string, relative: string): Promise<string> {
  const resolved = await realpath(path.resolve(root, relative));
  const fromRoot = path.relative(root, resolved);
  if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
    throw new Error('Workspace service cwd escapes its exact checkout.');
  }
  return resolved;
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error('Workspace service port is unavailable.')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve()));
  });
}

function healthUrl(service: WorkspaceManifestService): string | null {
  if (!service.port || !service.health?.http) return null;
  const value = service.health.http.replaceAll('{{port}}', String(service.port.preferred))
    .replaceAll(`{{service:${service.name}}}`, String(service.port.preferred));
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== service.port.preferred
    || url.username || url.password) {
    throw new Error('Workspace service health must target its own loopback port.');
  }
  return url.href;
}

async function waitForHealth(service: WorkspaceManifestService, child: ChildProcess, signal: AbortSignal): Promise<void> {
  const port = service.port!.preferred;
  const url = healthUrl(service);
  const timeoutMs = Math.min(MAX_HEALTH_TIMEOUT_MS, Math.max(1_000, service.health?.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted || child.exitCode !== null) throw new Error('Workspace service stopped before it became healthy.');
    try {
      if (url) {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1_500) });
        if (response.ok) return;
      } else {
        const connected = await new Promise<boolean>((resolve) => {
          const socket = connect({ host: '127.0.0.1', port });
          socket.once('connect', () => { socket.destroy(); resolve(true); });
          socket.once('error', () => { socket.destroy(); resolve(false); });
        });
        if (connected) return;
      }
    } catch { /* The service may still be starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Workspace service health timed out.');
}

export interface RunningWorkspaceServices {
  stop: () => Promise<{ healthyUntilStop: boolean }>;
  ownsPreview: (service: RemotePreviewService) => Promise<boolean>;
}

/** Start only exact-hash, coordinator-authorized commands in the leased clone. */
export async function startWorkspaceServices(input: {
  cloneDir: string;
  job: CloudWorkerJob;
  stream: EventStream;
  signal: AbortSignal;
}): Promise<RunningWorkspaceServices | null> {
  const hash = input.job.launch.remoteManifestHash;
  if (!hash) return null;
  if (process.platform === 'win32') {
    throw new Error('Remote workspace services require process-group cleanup support.');
  }
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid remote workspace manifest authorization.');
  const root = await realpath(input.cloneDir);
  const source = await readFile(path.join(root, WORKSPACE_MANIFEST_FILENAME));
  if (createHash('sha256').update(source).digest('hex') !== hash) {
    throw new Error('Remote workspace manifest differs from the authorized base revision.');
  }
  const manifest = parseWorkspaceManifest(JSON.parse(source.toString('utf8')) as unknown);
  const preview = remotePreviewService(manifest);
  if (input.job.launch.remotePreview && JSON.stringify(preview) !== JSON.stringify(input.job.launch.remotePreview)) {
    throw new Error('Remote preview differs from the authorized manifest.');
  }
  const children: Array<{ child: ChildProcess; service: WorkspaceManifestService }> = [];
  const failedNames = new Set<string>();
  const event = async (service: WorkspaceManifestService, state: 'healthy' | 'stopped' | 'failed') => {
    await input.stream.postEvent(input.job, 'service', {
      name: service.name,
      state,
      commandId: createHash('sha256').update(service.command).digest('hex'),
      manifestHash: hash,
      claimCount: input.job.claimCount,
      port: service.port?.preferred ?? null,
      health: state === 'healthy',
    });
  };
  let stopped = false;
  const stop = async () => {
    if (stopped) return { healthyUntilStop: failedNames.size === 0 };
    stopped = true;
    const exitedEarly = new Set(children
      .filter(({ child }) => child.exitCode !== null || child.signalCode !== null)
      .map(({ service }) => service.name));
    await Promise.all(children.map(({ child }) => stopAndWait(child)));
    for (const { service } of children) {
      if (failedNames.has(service.name)) continue;
      await event(service, exitedEarly.has(service.name) ? 'failed' : 'stopped').catch(() => {});
    }
    for (const command of manifest.teardown ?? []) {
      await runCommand(command, root, new AbortController().signal, 30_000).catch(() => {});
    }
    return { healthyUntilStop: failedNames.size === 0 && exitedEarly.size === 0 };
  };
  try {
    for (const command of manifest.setup ?? []) await runCommand(command, root, input.signal, SETUP_TIMEOUT_MS);
    for (const service of manifest.services ?? []) {
      if (!service.port || !service.health) {
        throw new Error('Remote workspace services require a port and health check.');
      }
      const cwd = await exactCwd(root, service.cwd ?? '.');
      await assertPortAvailable(service.port.preferred);
      const [program, args] = shell(service.command);
      const child = spawn(program, args, {
        cwd, env: childEnvironment(service.env, service.port), stdio: 'ignore', detached: true,
      });
      child.once('error', () => {});
      children.push({ child, service });
      const abort = () => signalTree(child, 'SIGTERM');
      input.signal.addEventListener('abort', abort, { once: true });
      try {
        await waitForHealth(service, child, input.signal);
        await event(service, 'healthy');
      } catch (error) {
        failedNames.add(service.name);
        await event(service, 'failed').catch(() => {});
        throw error;
      } finally {
        input.signal.removeEventListener('abort', abort);
      }
    }
    return { stop, ownsPreview: async (requested) => {
      if (stopped || input.signal.aborted || !preview || JSON.stringify(requested) !== JSON.stringify(preview)) return false;
      const item = children.find(({ service }) => service.name === requested.name);
      if (!item?.child.pid || item.child.exitCode !== null || item.child.signalCode !== null) return false;
      if (!await ownsListeningPort(item.child.pid, requested.port)) return false;
      const url = healthUrl(item.service);
      if (url) {
        try {
          const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([input.signal, AbortSignal.timeout(1_500)]) });
          await response.body?.cancel();
          if (!response.ok) return false;
        } catch { return false; }
      }
      return !stopped && !input.signal.aborted && item.child.exitCode === null && item.child.signalCode === null
        && await ownsListeningPort(item.child.pid, requested.port);
    } };
  } catch (error) {
    await stop();
    throw error;
  }
}
