import 'server-only';

import { randomBytes, randomUUID } from 'node:crypto';

import {
  getResourceLeaseStore,
} from './resource-lease-service';
import { observeResourceLeaseParticipant } from './resource-lease-participant';
import {
  normalizeResourceLeaseTtl,
  type ResourceLeaseHolder,
  type ResourceLeaseOwnerInput,
  type ResourceLeaseSnapshot,
  type ResourceLeaseWaiter,
} from './resource-lease-types';

const INTERNAL_WAIT_INTERVAL_MS = 50;
export const DEFAULT_INTERNAL_RESOURCE_LEASE_MAX_WAIT_MS = 5_000;
const MAX_INTERNAL_RESOURCE_LEASE_WAIT_MS = 10 * 60_000;

export interface ResourceLeaseGuardRefusal {
  code: 'resource_lease_wait_timeout' | 'resource_lease_acquire_failed';
  resource: string;
  waitedMs: number;
  holder: ResourceLeaseHolder | null;
  nextWaiter: ResourceLeaseWaiter | null;
  blocked: ResourceLeaseSnapshot['blocked'];
  message: string;
}

export type ResourceLeaseGuardResult<T> =
  | { state: 'completed'; value: T; lease: ResourceLeaseHolder }
  | { state: 'refused'; refusal: ResourceLeaseGuardRefusal };

function normalizeMaxWaitMs(value: number | undefined): number {
  const maxWaitMs = value ?? DEFAULT_INTERNAL_RESOURCE_LEASE_MAX_WAIT_MS;
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs <= 0 || maxWaitMs > MAX_INTERNAL_RESOURCE_LEASE_WAIT_MS) {
    throw new Error(`Resource lease max wait must be an integer from 1 through ${MAX_INTERNAL_RESOURCE_LEASE_WAIT_MS} milliseconds.`);
  }
  return maxWaitMs;
}

function waitBriefly(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function holderDescription(holder: ResourceLeaseHolder | null): string {
  return holder
    ? `${holder.owner.label} (${holder.owner.id}, pid ${holder.owner.pid})`
    : 'an unresolved FIFO claimant';
}

export async function withResourceLease<T>(input: {
  resource: string;
  owner: ResourceLeaseOwnerInput;
  actor: string;
  ttlMs?: number;
  maxWaitMs?: number;
}, action: () => Promise<T>): Promise<ResourceLeaseGuardResult<T>> {
  const startedAt = Date.now();
  const waiterId = `waiter-${randomUUID()}`;
  const claimToken = randomBytes(32).toString('base64url');
  let holder: ResourceLeaseHolder | null = null;
  let nextWaiter: ResourceLeaseWaiter | null = null;
  let blocked: ResourceLeaseSnapshot['blocked'] = null;
  let participant: Awaited<ReturnType<typeof observeResourceLeaseParticipant>> | null = null;
  let lease: ResourceLeaseHolder | null = null;
  let ttlMs = 0;

  try {
    const maxWaitMs = normalizeMaxWaitMs(input.maxWaitMs);
    ttlMs = normalizeResourceLeaseTtl(input.ttlMs);
    participant = await observeResourceLeaseParticipant({
      owner: input.owner,
      actor: input.actor,
      claimToken,
    });
    const store = getResourceLeaseStore();
    const deadline = startedAt + maxWaitMs;
    while (!lease) {
      const result = await store.acquire({
        resource: input.resource,
        participant,
        ttlMs,
        wait: true,
        waiterId,
      });
      if (result.state === 'acquired') {
        lease = result.lease;
        break;
      }
      holder = result.holder;
      nextWaiter = result.state === 'queued' ? result.waiter : result.nextWaiter;
      blocked = result.blocked;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        const snapshot = await store.timeoutWait({
          resource: input.resource,
          participant,
          waiterId,
        });
        holder = snapshot.holder;
        nextWaiter = snapshot.waiters[0] ?? null;
        blocked = snapshot.blocked;
        return {
          state: 'refused',
          refusal: {
            code: 'resource_lease_wait_timeout',
            resource: input.resource,
            waitedMs: Date.now() - startedAt,
            holder,
            nextWaiter,
            blocked,
            message: `${input.resource} remained held by ${holderDescription(holder)} after ${maxWaitMs}ms. The governed action was refused.`,
          },
        };
      }
      await waitBriefly(Math.min(INTERNAL_WAIT_INTERVAL_MS, remainingMs));
    }

  } catch (error) {
    if (participant) {
      await getResourceLeaseStore().timeoutWait({
        resource: input.resource,
        participant,
        waiterId,
      }).catch(() => undefined);
    }
    return {
      state: 'refused',
      refusal: {
        code: 'resource_lease_acquire_failed',
        resource: input.resource,
        waitedMs: Date.now() - startedAt,
        holder,
        nextWaiter,
        blocked,
        message: `Resource lease acquisition failed closed for ${input.resource}: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  const acquiredParticipant = participant;
  const acquiredLease = lease;
  const store = getResourceLeaseStore();
  const heartbeatEveryMs = Math.max(1_000, Math.min(30_000, Math.floor(ttlMs / 3)));
  const heartbeat = setInterval(() => {
    void store.heartbeat({ resource: input.resource, participant: acquiredParticipant, ttlMs })
      .catch(() => undefined);
  }, heartbeatEveryMs);
  heartbeat.unref?.();
  let actionError: unknown;
  try {
    return { state: 'completed', value: await action(), lease: acquiredLease };
  } catch (error) {
    actionError = error;
    throw error;
  } finally {
    clearInterval(heartbeat);
    try {
      await store.release({ resource: input.resource, participant: acquiredParticipant });
    } catch (releaseError) {
      if (actionError === undefined) throw releaseError;
      console.warn(
        `[resource-lease] Release failed after the guarded action failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
      );
    }
  }
}
