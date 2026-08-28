import 'server-only';

import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import path from 'node:path';

import { recordLaneEvent } from '@/lib/lane/events';
import { runRepoSetupCommand } from '@/lib/workspace/repo-setup';
import { loadWorkspaceManifest } from './loader';
import { allocateWorkspaceServicePorts } from './port-leases';
import type {
  WorkspaceManifest,
  WorkspaceManifestService,
  WorkspaceManifestServiceHealth,
} from './types';

const SETUP_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

export interface WorkspaceManifestHealthReceipt {
  kind: 'http' | 'tcp';
  target: string;
  ok: boolean;
  durationMs: number;
  checkedAt: string;
  error?: string;
}

export interface WorkspaceManifestSetupReceipt {
  index: number;
  commandId: string;
  durationMs: number;
  completedAt: string;
}

export interface WorkspaceManifestServiceReceipt {
  name: string;
  commandId: string;
  cwd: string;
  port: number | null;
  environment: NodeJS.ProcessEnv;
  health: WorkspaceManifestHealthReceipt | null;
}

export interface WorkspaceManifestApplyResult {
  ports: Record<string, number>;
  preview?: string;
  receipts: {
    setup: WorkspaceManifestSetupReceipt[];
    services: WorkspaceManifestServiceReceipt[];
    completedAt: string;
  };
}

type ApplyStep = 'load' | 'ports' | 'preview' | `setup:${number}`;

function commandId(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function setupShell(command: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    };
  }
  return { command: '/bin/sh', args: ['-lc', command] };
}

function portEnvironment(
  manifest: WorkspaceManifest,
  ports: Record<string, number>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? 'development',
  };
  for (const service of manifest.services ?? []) {
    const name = service.port?.env;
    if (!name) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Service ${service.name} has an invalid port environment name.`);
    }
    const value = String(ports[service.name]);
    if (environment[name] !== undefined && environment[name] !== value) {
      throw new Error(`Workspace services assign different ports to environment variable ${name}.`);
    }
    environment[name] = value;
  }
  return environment;
}

function resolveTemplate(
  template: string,
  ports: Record<string, number>,
  defaultPort?: number,
): string {
  let resolved = template.replaceAll('{{port}}', () => {
    if (defaultPort === undefined) throw new Error('Preview {{port}} has no allocated service port.');
    return String(defaultPort);
  });
  resolved = resolved.replace(/\{\{service:([^}]+)\}\}/g, (_match, serviceName: string) => {
    const port = ports[serviceName];
    if (port === undefined) {
      throw new Error(`Template references service ${JSON.stringify(serviceName)} without an allocated port.`);
    }
    return String(port);
  });
  if (/\{\{[^}]+\}\}/.test(resolved)) {
    throw new Error(`Template contains an unsupported placeholder: ${resolved}.`);
  }
  return resolved;
}

function tcpHealth(port: number, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: `TCP health probe timed out after ${timeoutMs}ms.` }),
      timeoutMs,
    );
    socket.once('connect', () => finish({ ok: true }));
    socket.once('error', (error) => finish({ ok: false, error: error.message }));
  });
}

async function httpHealth(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok
      ? { ok: true }
      : { ok: false, error: `HTTP health probe returned ${response.status}.` };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

async function probeHealth(input: {
  health: WorkspaceManifestServiceHealth;
  service: WorkspaceManifestService;
  ports: Record<string, number>;
}): Promise<WorkspaceManifestHealthReceipt> {
  const startedAt = Date.now();
  const timeoutMs = input.health.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const port = input.ports[input.service.name];
  let kind: WorkspaceManifestHealthReceipt['kind'];
  let target: string;
  let result: { ok: boolean; error?: string };
  if (input.health.http !== undefined) {
    kind = 'http';
    target = resolveTemplate(input.health.http, input.ports, port);
    result = await httpHealth(target, timeoutMs);
  } else {
    kind = 'tcp';
    target = port === undefined ? '127.0.0.1:(unallocated)' : `127.0.0.1:${port}`;
    result = port === undefined
      ? { ok: false, error: 'TCP health probe requires an allocated service port.' }
      : await tcpHealth(port, timeoutMs);
  }
  return {
    kind,
    target,
    ok: result.ok,
    durationMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
    ...(result.error ? { error: result.error } : {}),
  };
}

async function applyLoadedManifest(input: {
  manifest: WorkspaceManifest;
  worktreePath: string;
  packetId: string;
  laneId: string;
  setStep: (step: ApplyStep) => void;
}): Promise<WorkspaceManifestApplyResult> {
  input.setStep('ports');
  const services = input.manifest.services ?? [];
  const ports = await allocateWorkspaceServicePorts({
    packetId: input.packetId,
    laneId: input.laneId,
    services: services.flatMap((service) => service.port
      ? [{ name: service.name, preferred: service.port.preferred }]
      : []),
  });
  const allocatedEnvironment = portEnvironment(input.manifest, ports);
  const setupEnvironment = { ...process.env, ...allocatedEnvironment };
  const setupReceipts: WorkspaceManifestSetupReceipt[] = [];
  for (const [index, setupCommand] of (input.manifest.setup ?? []).entries()) {
    input.setStep(`setup:${index + 1}`);
    const startedAt = Date.now();
    const shell = setupShell(setupCommand);
    await runRepoSetupCommand({
      ...shell,
      cwd: input.worktreePath,
      timeoutMs: SETUP_TIMEOUT_MS,
      env: setupEnvironment,
    });
    setupReceipts.push({
      index,
      commandId: commandId(setupCommand),
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    });
  }
  const serviceReceipts: WorkspaceManifestServiceReceipt[] = [];
  for (const service of services) {
    const cwd = path.resolve(input.worktreePath, service.cwd ?? '.');
    if (!pathInside(cwd, input.worktreePath)) {
      throw new Error(`Service ${service.name} cwd escapes the packet worktree.`);
    }
    const health = service.health
      ? await probeHealth({ health: service.health, service, ports })
      : null;
    serviceReceipts.push({
      name: service.name,
      commandId: commandId(service.command),
      cwd,
      port: ports[service.name] ?? null,
      environment: { ...service.env, ...allocatedEnvironment },
      health,
    });
  }
  input.setStep('preview');
  const firstPort = services.map((service) => ports[service.name]).find((port) => port !== undefined);
  const preview = input.manifest.preview
    ? resolveTemplate(input.manifest.preview.url, ports, firstPort)
    : undefined;
  return {
    ports,
    ...(preview ? { preview } : {}),
    receipts: {
      setup: setupReceipts,
      services: serviceReceipts,
      completedAt: new Date().toISOString(),
    },
  };
}

function recordEventSafely(
  laneId: string,
  verb: 'workspace_manifest_applied' | 'workspace_manifest_failed',
  payload: Record<string, unknown>,
): void {
  try {
    recordLaneEvent(laneId, verb, 'system', payload);
  } catch (error) {
    console.warn(`[workspace-manifest] Could not record ${verb} for ${laneId}: ${formatError(error)}`);
  }
}

export async function applyWorkspaceManifest(input: {
  repoPath: string;
  worktreePath: string;
  packetId: string;
  laneId: string;
}): Promise<WorkspaceManifestApplyResult | null> {
  const startedAt = Date.now();
  let step: ApplyStep = 'load';
  try {
    const manifest = await loadWorkspaceManifest(input.worktreePath);
    if (!manifest) return null;
    const result = await applyLoadedManifest({
      manifest,
      worktreePath: path.resolve(input.worktreePath),
      packetId: input.packetId,
      laneId: input.laneId,
      setStep: (next) => { step = next; },
    });
    recordEventSafely(input.laneId, 'workspace_manifest_applied', {
      services: Object.entries(result.ports).map(([name, port]) => ({ name, port })),
      ...(result.preview ? { preview: result.preview } : {}),
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    const message = formatError(error);
    console.warn(
      `[workspace-manifest] Apply failed for packet ${input.packetId} in ${path.resolve(input.repoPath)} at ${step}: ${message}`,
    );
    recordEventSafely(input.laneId, 'workspace_manifest_failed', { step, error: message });
    return null;
  }
}
