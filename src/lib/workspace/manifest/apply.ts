import 'server-only';

import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import path from 'node:path';

import { recordLaneEvent } from '@/lib/lane/events';
import { getOperatorDefaults } from '@/lib/operator/defaults';
import { runRepoSetupCommand } from '@/lib/workspace/repo-setup';
import {
  beginWorkspaceManifestRun,
  finishWorkspaceManifestRun,
  settleWorkspaceManifestRun,
  updateWorkspaceManifestRun,
  type WorkspaceManifestHealthReceipt,
  type WorkspaceManifestLifecycleRun,
  type WorkspaceManifestServiceReceipt,
  type WorkspaceManifestSetupReceipt,
  type WorkspaceManifestState,
} from './lifecycle';
import { loadWorkspaceManifestSource } from './loader';
import {
  findWorkspaceManifestApproval,
  resolveWorkspaceManifestExecution,
} from './policy';
import { allocateWorkspaceServicePorts } from './port-leases';
import type {
  WorkspaceManifest,
  WorkspaceManifestService,
  WorkspaceManifestServiceHealth,
} from './types';

const DEFAULT_SETUP_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
let setupTimeoutOverrideForTest: number | null = null;

export type {
  WorkspaceManifestHealthReceipt,
  WorkspaceManifestServiceReceipt,
  WorkspaceManifestSetupReceipt,
} from './lifecycle';

export interface WorkspaceManifestApplyResult {
  ports: Record<string, number>;
  preview?: string;
  receipts: {
    setup: WorkspaceManifestSetupReceipt[];
    services: WorkspaceManifestServiceReceipt[];
    completedAt: string;
  };
}

type ApplyStep = 'load' | 'policy' | 'ports' | 'services' | 'preview' | `setup:${number}`;

class WorkspaceManifestSetupTimeoutError extends Error {
  constructor(
    readonly step: `setup:${number}`,
    readonly commandId: string,
    timeoutMs: number,
  ) {
    super(`Workspace manifest ${step} (${commandId}) timed out after ${timeoutMs}ms.`);
    this.name = 'WorkspaceManifestSetupTimeoutError';
  }
}

class WorkspaceManifestCancelledError extends Error {
  constructor() {
    super('Workspace manifest cancelled because its lane became terminal.');
    this.name = 'WorkspaceManifestCancelledError';
  }
}

export function setWorkspaceManifestSetupTimeoutForTest(timeoutMs: number | null): void {
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error('Workspace manifest setup timeout must be a positive number.');
  }
  setupTimeoutOverrideForTest = timeoutMs;
}

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
  lifecycle: WorkspaceManifestLifecycleRun;
  setupTimeoutMs: number;
  setStep: (step: ApplyStep, commandId?: string) => Promise<void>;
}): Promise<WorkspaceManifestApplyResult> {
  await input.setStep('ports');
  const services = input.manifest.services ?? [];
  const ports = await allocateWorkspaceServicePorts({
    packetId: input.packetId,
    laneId: input.laneId,
    services: services.flatMap((service) => service.port
      ? [{ name: service.name, preferred: service.port.preferred }]
      : []),
  });
  await updateWorkspaceManifestRun(input.lifecycle, (receipt) => ({ ...receipt, ports }));
  const allocatedEnvironment = portEnvironment(input.manifest, ports);
  const setupEnvironment = { ...process.env, ...allocatedEnvironment };
  const setupReceipts: WorkspaceManifestSetupReceipt[] = [];
  for (const [index, setupCommand] of (input.manifest.setup ?? []).entries()) {
    const step = `setup:${index + 1}` as const;
    const setupCommandId = commandId(setupCommand);
    await input.setStep(step, setupCommandId);
    const startedAt = Date.now();
    const shell = setupShell(setupCommand);
    const timeoutController = new AbortController();
    const timeoutError = new WorkspaceManifestSetupTimeoutError(
      step,
      setupCommandId,
      input.setupTimeoutMs,
    );
    const timer = setTimeout(() => timeoutController.abort(timeoutError), input.setupTimeoutMs);
    timer.unref?.();
    try {
      await runRepoSetupCommand({
        ...shell,
        cwd: input.worktreePath,
        timeoutMs: input.setupTimeoutMs,
        env: setupEnvironment,
        signal: AbortSignal.any([input.lifecycle.signal, timeoutController.signal]),
      });
    } catch (error) {
      if (input.lifecycle.signal.aborted) throw new WorkspaceManifestCancelledError();
      if (timeoutController.signal.aborted) throw timeoutError;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (input.lifecycle.signal.aborted) throw new WorkspaceManifestCancelledError();
    const setupReceipt: WorkspaceManifestSetupReceipt = {
      index,
      commandId: setupCommandId,
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    };
    setupReceipts.push(setupReceipt);
    await updateWorkspaceManifestRun(input.lifecycle, (receipt) => {
      const next = { ...receipt, setup: [...receipt.setup, setupReceipt] };
      delete next.commandId;
      return next;
    });
  }
  const serviceReceipts: WorkspaceManifestServiceReceipt[] = [];
  await input.setStep('services');
  for (const service of services) {
    if (input.lifecycle.signal.aborted) throw new WorkspaceManifestCancelledError();
    const cwd = path.resolve(input.worktreePath, service.cwd ?? '.');
    if (!pathInside(cwd, input.worktreePath)) {
      throw new Error(`Service ${service.name} cwd escapes the packet worktree.`);
    }
    const health = service.health
      ? await probeHealth({ health: service.health, service, ports })
      : null;
    const serviceReceipt: WorkspaceManifestServiceReceipt = {
      name: service.name,
      commandId: commandId(service.command),
      cwd,
      port: ports[service.name] ?? null,
      environment: { ...service.env, ...allocatedEnvironment },
      health,
    };
    serviceReceipts.push(serviceReceipt);
    await updateWorkspaceManifestRun(input.lifecycle, (receipt) => ({
      ...receipt,
      services: [...receipt.services, serviceReceipt],
    }));
  }
  await input.setStep('preview');
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
  verb: 'workspace_manifest_applied' | 'workspace_manifest_failed' | 'workspace_manifest_skipped',
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
  let lifecycle: WorkspaceManifestLifecycleRun | null = null;
  try {
    const loaded = await loadWorkspaceManifestSource(input.worktreePath);
    if (!loaded) return null;
    step = 'policy';
    const policy = (await getOperatorDefaults()).values.workspaceManifestPolicy;
    const decision = await resolveWorkspaceManifestExecution({
      repoPath: input.repoPath,
      manifestSource: loaded.source,
      policy,
    });
    if (!decision.allowed) {
      const approval = decision.reason === 'awaiting_approval' || decision.reason === 'rejected'
        ? findWorkspaceManifestApproval(input.repoPath, decision.manifestHash)
        : null;
      recordEventSafely(input.laneId, 'workspace_manifest_skipped', {
        policy,
        manifestHash: decision.manifestHash,
        ...(approval ? { approvalId: approval.id } : {}),
        ...(decision.reason === 'rejected' ? { reason: 'rejected' } : {}),
      });
      return null;
    }
    lifecycle = await beginWorkspaceManifestRun({
      worktreePath: path.resolve(input.worktreePath),
      packetId: input.packetId,
      laneId: input.laneId,
      manifestHash: decision.manifestHash,
    });
    const result = await applyLoadedManifest({
      manifest: loaded.manifest,
      worktreePath: path.resolve(input.worktreePath),
      packetId: input.packetId,
      laneId: input.laneId,
      lifecycle,
      setupTimeoutMs: setupTimeoutOverrideForTest ?? DEFAULT_SETUP_TIMEOUT_MS,
      setStep: async (next, setupCommandId) => {
        step = next;
        await updateWorkspaceManifestRun(lifecycle!, (receipt) => {
          const updated = { ...receipt, step: next };
          if (setupCommandId) updated.commandId = setupCommandId;
          else delete updated.commandId;
          return updated;
        });
      },
    });
    if (lifecycle.signal.aborted) throw new WorkspaceManifestCancelledError();
    const settlement = await settleWorkspaceManifestRun(lifecycle, { state: 'completed' });
    if (settlement.changed) {
      recordEventSafely(input.laneId, 'workspace_manifest_applied', {
        services: Object.entries(result.ports).map(([name, port]) => ({ name, port })),
        ...(result.preview ? { preview: result.preview } : {}),
        durationMs: Date.now() - startedAt,
        state: 'completed',
      });
      return result;
    }
    return null;
  } catch (error) {
    const message = formatError(error);
    const state: Exclude<WorkspaceManifestState, 'running' | 'completed' | 'crashed'> =
      error instanceof WorkspaceManifestSetupTimeoutError
        ? 'timed_out'
        : error instanceof WorkspaceManifestCancelledError || lifecycle?.signal.aborted
          ? 'cancelled'
          : 'failed';
    const commandId = error instanceof WorkspaceManifestSetupTimeoutError
      ? error.commandId
      : undefined;
    console.warn(
      `[workspace-manifest] Apply failed for packet ${input.packetId} in ${path.resolve(input.repoPath)} at ${step}: ${message}`,
    );
    const settlement = lifecycle
      ? await settleWorkspaceManifestRun(lifecycle, { state, step, commandId, error: message })
      : { receipt: null, changed: true };
    if (settlement.changed) {
      recordEventSafely(input.laneId, 'workspace_manifest_failed', {
        step,
        ...(commandId ? { commandId } : {}),
        error: message,
        state,
      });
    }
    return null;
  } finally {
    if (lifecycle) finishWorkspaceManifestRun(lifecycle);
  }
}
