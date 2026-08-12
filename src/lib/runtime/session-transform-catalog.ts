import 'server-only';

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { writeJsonFile } from '@/lib/fs/json';
import type { RuntimeSessionOwnership, RuntimeSessionTransformAction } from '@/lib/runtimes/types';

const CATALOG_FILE = 'session-transform-catalog.json';
const INTENTS_FILE = 'session-transform-intents.json';
const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 8_000;
const LOCK_RETRY_MS = 25;

export interface SessionCatalogLineage {
  action: 'fork' | 'rewind';
  parentSessionKey: string;
  checkpointId: string;
}

export interface SessionCatalogEntry {
  runtimeId: string;
  sessionKey: string;
  /** Opaque identity attribution only; provider config paths remain server-private. */
  identityId?: string | null;
  displayName: string;
  ownership: RuntimeSessionOwnership;
  cwd: string;
  repoPath: string | null;
  branch: string | null;
  importedAt: string;
  provenance: 'import' | 'fork' | 'rewind';
  lineage: SessionCatalogLineage | null;
}

export interface SessionCatalogCheckpoint {
  id: string;
  runtimeId: string;
  sessionKey: string;
  createdAt: string;
  headSha: string | null;
  providerRef: string;
}

export interface SessionTransformReceipt {
  id: string;
  clientMutationId?: string | null;
  action: RuntimeSessionTransformAction;
  runtimeId: string;
  originalSessionKey: string;
  resultingSessionKey: string;
  checkpointId: string | null;
  beforeHeadSha: string | null;
  afterHeadSha: string | null;
  providerSessionCreated: boolean;
  packetId: string | null;
  laneId: string | null;
  staleGovernanceInvalidated: boolean;
  createdAt: string;
}

export interface SessionTransformIntentSession {
  runtimeId: string;
  sessionKey: string;
  identityId?: string | null;
  displayName: string;
  ownership: RuntimeSessionOwnership;
  cwd: string;
  branch: string | null;
}

export interface SessionTransformIntent {
  id: string;
  clientMutationId?: string | null;
  action: 'fork' | 'rewind';
  runtimeId: string;
  originalSessionKey: string;
  identityId?: string | null;
  checkpointId: string;
  providerCheckpointRef: string;
  expectedCatalogVersion: number;
  phase: 'prepared' | 'provider_started' | 'provider_succeeded';
  startedAt: string;
  beforeHeadSha: string | null;
  codeCwd: string | null;
  laneId: string | null;
  packetId: string | null;
  result: {
    note: string;
    resultingSession: SessionTransformIntentSession;
    providerSessionCreated: boolean;
    afterHeadSha: string | null;
  } | null;
}

interface SessionTransformIntentStore {
  schema: 'o8/session-transform-intents/v1';
  intents: SessionTransformIntent[];
}

export interface SessionTransformCatalog {
  schema: 'o8/session-transform-catalog/v1';
  version: number;
  sessions: SessionCatalogEntry[];
  checkpoints: SessionCatalogCheckpoint[];
  receipts: SessionTransformReceipt[];
}

export type PublicSessionCatalogCheckpoint = Omit<SessionCatalogCheckpoint, 'providerRef'>;

export interface PublicSessionTransformCatalog {
  schema: SessionTransformCatalog['schema'];
  version: number;
  sessions: SessionCatalogEntry[];
  checkpoints: PublicSessionCatalogCheckpoint[];
  receipts: Array<Omit<SessionTransformReceipt, 'clientMutationId'>>;
}

const sessionQueues = new Map<string, Promise<void>>();

function catalogPath() {
  return path.join(getDataDir(), CATALOG_FILE);
}

function intentsPath() {
  return path.join(getDataDir(), INTENTS_FILE);
}

function lockPath() {
  return `${catalogPath()}.lock`;
}

function emptyCatalog(): SessionTransformCatalog {
  return {
    schema: 'o8/session-transform-catalog/v1',
    version: 0,
    sessions: [],
    checkpoints: [],
    receipts: [],
  };
}

function emptyIntentStore(): SessionTransformIntentStore {
  return { schema: 'o8/session-transform-intents/v1', intents: [] };
}

function isCatalog(value: unknown): value is SessionTransformCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<SessionTransformCatalog>;
  return candidate.schema === 'o8/session-transform-catalog/v1'
    && Number.isInteger(candidate.version)
    && Array.isArray(candidate.sessions)
    && Array.isArray(candidate.checkpoints)
    && Array.isArray(candidate.receipts);
}

export async function readSessionTransformCatalog(): Promise<SessionTransformCatalog> {
  try {
    const parsed = JSON.parse(await readFile(catalogPath(), 'utf8')) as unknown;
    if (!isCatalog(parsed)) throw new Error('Session transform catalog has an unsupported shape.');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCatalog();
    throw error;
  }
}

export function publicSessionTransformCatalog(
  catalog: SessionTransformCatalog,
): PublicSessionTransformCatalog {
  return {
    schema: catalog.schema,
    version: catalog.version,
    sessions: catalog.sessions,
    checkpoints: catalog.checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      runtimeId: checkpoint.runtimeId,
      sessionKey: checkpoint.sessionKey,
      createdAt: checkpoint.createdAt,
      headSha: checkpoint.headSha,
    })),
    receipts: catalog.receipts.map((receipt) => ({
      id: receipt.id,
      action: receipt.action,
      runtimeId: receipt.runtimeId,
      originalSessionKey: receipt.originalSessionKey,
      resultingSessionKey: receipt.resultingSessionKey,
      checkpointId: receipt.checkpointId,
      beforeHeadSha: receipt.beforeHeadSha,
      afterHeadSha: receipt.afterHeadSha,
      providerSessionCreated: receipt.providerSessionCreated,
      packetId: receipt.packetId,
      laneId: receipt.laneId,
      staleGovernanceInvalidated: receipt.staleGovernanceInvalidated,
      createdAt: receipt.createdAt,
    })),
  };
}

export async function writeSessionTransformCatalog(catalog: SessionTransformCatalog): Promise<void> {
  const dir = getDataDir();
  await mkdir(dir, { recursive: true });
  await writeJsonFile(catalogPath(), catalog, { mode: 0o600 });
}

export async function readSessionTransformIntents(): Promise<SessionTransformIntent[]> {
  try {
    const parsed = JSON.parse(await readFile(intentsPath(), 'utf8')) as Partial<SessionTransformIntentStore>;
    if (parsed.schema !== 'o8/session-transform-intents/v1' || !Array.isArray(parsed.intents)) {
      throw new Error('Session transform intent store has an unsupported shape.');
    }
    return parsed.intents;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function writeSessionTransformIntents(intents: SessionTransformIntent[]): Promise<void> {
  const dir = getDataDir();
  await mkdir(dir, { recursive: true });
  await writeJsonFile(intentsPath(), { ...emptyIntentStore(), intents }, { mode: 0o600 });
}

async function lockIsStale() {
  try {
    const details = await stat(lockPath());
    return Date.now() - details.mtimeMs > LOCK_STALE_MS;
  } catch {
    return true;
  }
}

async function acquireCatalogLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  await mkdir(getDataDir(), { recursive: true });
  for (;;) {
    try {
      await mkdir(lockPath());
      await writeFile(path.join(lockPath(), 'holder.json'), JSON.stringify({
        pid: process.pid,
        at: Date.now(),
      }), { mode: 0o600 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await lockIsStale()) {
        await rm(lockPath(), { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the session transform catalog lock.');
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function releaseCatalogLock() {
  await rm(lockPath(), { recursive: true, force: true });
}

export async function withSessionTransformCatalogLock<T>(
  runtimeId: string,
  sessionKey: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = `${runtimeId}:${sessionKey}`;
  const previous = sessionQueues.get(key) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const queued = previous.then(() => current);
  sessionQueues.set(key, queued);
  await previous;
  try {
    await acquireCatalogLock();
    try {
      return await run();
    } finally {
      await releaseCatalogLock();
    }
  } finally {
    releaseQueue();
    if (sessionQueues.get(key) === queued) sessionQueues.delete(key);
  }
}

export function sessionIsCataloged(
  catalog: Pick<SessionTransformCatalog, 'sessions'>,
  runtimeId: string,
  sessionKey: string,
) {
  return catalog.sessions.some((session) => (
    session.runtimeId === runtimeId && session.sessionKey === sessionKey
  ));
}
