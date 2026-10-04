import { AsyncLocalStorage } from 'node:async_hooks';
import { ownedRoots } from '../owned-session-index';
import { createOwnedSessionIo, type OwnedSessionIo } from './session-io';
import type { OwnedSessionRecord } from './types';

export class AutomaticRecoveryRefusedError extends Error {}

type SurfaceLock = <T>(surfaceId: string, operation: () => Promise<T>) => Promise<T>;
const stores = new Map<string, { io: OwnedSessionIo; lock: SurfaceLock }>();
const recoveryRequest = new AsyncLocalStorage<{ surfaceId: string; runId: string }>();

export function registerOwnedRecoveryStore(prefix: string, io: OwnedSessionIo, lock: SurfaceLock): void {
  stores.set(prefix, { io, lock });
}

export function currentRecoveryRun(session: OwnedSessionRecord) {
  return session.activeRun ?? session.recentRuns[0];
}

export function recoveryInterrupted(session: OwnedSessionRecord): boolean {
  const run = currentRecoveryRun(session);
  return Boolean(run && (run.outcome === 'interrupted' || run.interruptRequestedAt));
}

/** Read durable current-generation evidence, without refreshing or retrying it. */
export async function readOwnedRecoveryState(surfaceId: string) {
  const root = ownedRoots().find(entry => surfaceId.startsWith(entry.marker));
  if (!root) return { owned: false as const };
  const store = stores.get(root.marker);
  const io = store?.io ?? createOwnedSessionIo({ root: root.root, surfacePrefix: root.marker, invalidateFleetCache: () => {} });
  const session = await io.findSession(surfaceId).catch(() => null);
  return { owned: true as const, runId: session ? currentRecoveryRun(session)?.id : undefined,
    outcome: session ? currentRecoveryRun(session)?.outcome : undefined,
    interrupted: session ? recoveryInterrupted(session) : false };
}

export function assertAutomaticRecoveryGeneration(session: OwnedSessionRecord | null, runId: string): void {
  if (!session || session.detachedAt || session.orphanedAt
    || currentRecoveryRun(session)?.id !== runId || recoveryInterrupted(session)) {
    throw new AutomaticRecoveryRefusedError('Automatic recovery refused: the current run changed or was interrupted. Use an explicit resume.');
  }
}

export function requestedAutomaticRecoveryRun(surfaceId: string): string | undefined {
  const request = recoveryRequest.getStore();
  if (request && request.surfaceId !== surfaceId) throw new AutomaticRecoveryRefusedError('Automatic recovery refused: the owned target changed.');
  return request?.runId;
}

export function withAutomaticRecoveryRequest<T>(surfaceId: string, runId: string, operation: () => Promise<T>): Promise<T> {
  if (![...stores.keys()].some(prefix => surfaceId.startsWith(prefix))) {
    throw new AutomaticRecoveryRefusedError('Automatic recovery refused: the owned session lock is unavailable.');
  }
  return recoveryRequest.run({ surfaceId, runId }, operation);
}

/** A restrictive generation fence, never an authorization or an explicit resume. */
export async function withOwnedAutomaticRecovery<T>(surfaceId: string, runId: string, operation: () => Promise<T>): Promise<T> {
  const store = [...stores.entries()].find(([prefix]) => surfaceId.startsWith(prefix))?.[1];
  if (!store) throw new AutomaticRecoveryRefusedError('Automatic recovery refused: the owned session lock is unavailable.');
  return store.lock(surfaceId, async () => {
    const current = await store.io.findSession(surfaceId);
    assertAutomaticRecoveryGeneration(current, runId);
    return operation();
  });
}
