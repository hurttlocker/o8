import 'server-only';

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { O8_RESERVED_PORTS } from '@/lib/panel/port-constants';
import {
  acquireMetadataTransactionLease,
  releaseMetadataTransactionLease,
} from '@/lib/worktree/metadata-transaction-lease';

const STORE_VERSION = 1 as const;
const STORE_FILENAME = 'workspace-port-leases.json';

export interface WorkspacePortLease {
  packetId: string;
  laneId: string;
  service: string;
  acquiredAt: number;
}

interface WorkspacePortLeaseStore {
  version: typeof STORE_VERSION;
  leases: Record<string, WorkspacePortLease>;
}

export interface WorkspacePortRequest {
  name: string;
  preferred: number;
}

function emptyStore(): WorkspacePortLeaseStore {
  return { version: STORE_VERSION, leases: {} };
}

function requiredText(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} is required.`);
  return trimmed;
}

function isLease(value: unknown): value is WorkspacePortLease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const lease = value as Partial<WorkspacePortLease>;
  return typeof lease.packetId === 'string' && lease.packetId.length > 0
    && typeof lease.laneId === 'string' && lease.laneId.length > 0
    && typeof lease.service === 'string' && lease.service.length > 0
    && Number.isSafeInteger(lease.acquiredAt) && lease.acquiredAt! > 0;
}

function validateStore(value: unknown): WorkspacePortLeaseStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workspace port lease store is not an object.');
  }
  const store = value as Partial<WorkspacePortLeaseStore>;
  if (store.version !== STORE_VERSION
    || !store.leases
    || typeof store.leases !== 'object'
    || Array.isArray(store.leases)
    || !Object.entries(store.leases).every(([port, lease]) => (
      /^(?:[1-9]\d{0,4})$/.test(port)
      && Number(port) <= 65_535
      && isLease(lease)
    ))) {
    throw new Error('Workspace port lease store has an unsupported shape.');
  }
  return store as WorkspacePortLeaseStore;
}

export function workspacePortLeaseStorePath(): string {
  return path.join(getDataDir(), STORE_FILENAME);
}

async function readStore(): Promise<WorkspacePortLeaseStore> {
  try {
    return validateStore(JSON.parse(await readFile(workspacePortLeaseStorePath(), 'utf8')) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw error;
  }
}

async function writeStore(store: WorkspacePortLeaseStore): Promise<void> {
  const storePath = workspacePortLeaseStorePath();
  const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryPath, storePath);
  await chmod(storePath, 0o600).catch(() => {});
}

async function withStoreMutation<T>(
  operation: (store: WorkspacePortLeaseStore) => Promise<{ result: T; changed: boolean }>,
): Promise<T> {
  const lease = await acquireMetadataTransactionLease(getDataDir());
  try {
    const store = await readStore();
    const { result, changed } = await operation(store);
    if (changed) await writeStore(store);
    return result;
  } finally {
    releaseMetadataTransactionLease(lease);
  }
}

export function probeWorkspacePortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      if (!server.listening) {
        resolve(available);
        return;
      }
      server.close(() => resolve(available));
    };
    server.once('error', () => finish(false));
    server.once('listening', () => finish(true));
    server.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

async function nextAvailablePort(
  preferred: number,
  leases: Record<string, WorkspacePortLease>,
): Promise<number> {
  for (let port = preferred; port <= 65_535; port += 1) {
    if (O8_RESERVED_PORTS.has(port) || leases[String(port)]) continue;
    if (await probeWorkspacePortAvailable(port)) return port;
  }
  throw new Error(`No workspace service port is available at or above ${preferred}.`);
}

export async function allocateWorkspaceServicePorts(input: {
  packetId: string;
  laneId: string;
  services: WorkspacePortRequest[];
  now?: () => number;
}): Promise<Record<string, number>> {
  const packetId = requiredText(input.packetId, 'packetId');
  const laneId = requiredText(input.laneId, 'laneId');
  const requests = input.services.map((service) => ({
    name: requiredText(service.name, 'service name'),
    preferred: service.preferred,
  }));
  for (const request of requests) {
    if (!Number.isInteger(request.preferred) || request.preferred < 1 || request.preferred > 65_535) {
      throw new Error(`Service ${request.name} preferred port must be an integer from 1 through 65535.`);
    }
  }
  return withStoreMutation(async (store) => {
    const ports: Record<string, number> = {};
    let changed = false;
    for (const request of requests) {
      const existing = Object.entries(store.leases).find(([, lease]) => (
        lease.packetId === packetId
        && lease.laneId === laneId
        && lease.service === request.name
      ));
      if (existing) {
        ports[request.name] = Number(existing[0]);
        continue;
      }
      const port = await nextAvailablePort(request.preferred, store.leases);
      store.leases[String(port)] = {
        packetId,
        laneId,
        service: request.name,
        acquiredAt: (input.now ?? Date.now)(),
      };
      ports[request.name] = port;
      changed = true;
    }
    return { result: ports, changed };
  });
}

export async function releaseWorkspacePortLeases(input: {
  packetId?: string | null;
  laneId: string;
}): Promise<number> {
  const laneId = requiredText(input.laneId, 'laneId');
  const packetId = input.packetId?.trim() || null;
  return withStoreMutation(async (store) => {
    let released = 0;
    for (const [port, lease] of Object.entries(store.leases)) {
      if (lease.laneId !== laneId || (packetId && lease.packetId !== packetId)) continue;
      delete store.leases[port];
      released += 1;
    }
    return { result: released, changed: released > 0 };
  });
}

export async function readWorkspacePortLeases(): Promise<Record<number, WorkspacePortLease>> {
  return Object.fromEntries(
    Object.entries((await readStore()).leases).map(([port, lease]) => [Number(port), lease]),
  );
}
