import { AsyncLocalStorage } from 'node:async_hooks';
import { chainOnKey } from '@/lib/util/keyed-promise-chain';
import {
  acquireWorkspaceLifecycleLease,
  releaseWorkspaceLifecycleLease,
} from '@/lib/orchestrator/workspace-lifecycle-lease';

const packetLifecycleChains = new Map<string, Promise<unknown>>();
const packetLifecycleDepth = new Map<string, number>();
const missionHandoffChains = new Map<string, Promise<unknown>>();
interface LifecycleAuthority { active: boolean }
const heldLifecyclePackets = new AsyncLocalStorage<ReadonlyMap<string, LifecycleAuthority>>();

export interface PacketLifecycleMutationContext {
  /** Another lifecycle mutation for this packet was already queued or running. */
  contended: boolean;
  /**
   * Contention came from a competing intent — a queued in-process mutation or a
   * lease owner that could not be proven dead. Reclaiming a crashed owner's
   * abandoned lease sets `contended` but NOT this, so recovery of that owner's
   * own interrupted request is not refused as if it were newer intent (#2313).
   */
  contendedByLiveIntent: boolean;
}

/**
 * Serialize destructive packet lifecycle mutations in submission order. A
 * contended caller receives that fact after its predecessor finishes so it can
 * fail closed instead of applying a second destructive intent to the newer
 * packet generation.
 */
export async function withPacketLifecycleMutationLock<T>(
  packetId: string,
  mutation: (context: PacketLifecycleMutationContext) => Promise<T>,
): Promise<T> {
  const key = packetId.trim();
  const contended = (packetLifecycleDepth.get(key) ?? 0) > 0;
  packetLifecycleDepth.set(key, (packetLifecycleDepth.get(key) ?? 0) + 1);
  try {
    return await chainOnKey(packetLifecycleChains, key, async () => {
      const lease = await acquireWorkspaceLifecycleLease(key);
      const authority: LifecycleAuthority = { active: true };
      try {
        return await heldLifecyclePackets.run(new Map([...(heldLifecyclePackets.getStore() ?? []), [key, authority]]), () => mutation({
          contended: contended || lease.contended,
          contendedByLiveIntent: contended || lease.contendedByLiveOwner,
        }));
      } finally {
        authority.active = false;
        releaseWorkspaceLifecycleLease(lease);
      }
    });
  } finally {
    const remaining = (packetLifecycleDepth.get(key) ?? 1) - 1;
    if (remaining > 0) packetLifecycleDepth.set(key, remaining);
    else packetLifecycleDepth.delete(key);
  }
}

/** A surface-locked spawn must refuse a competing lifecycle owner without waiting for its surface lock. */
export async function withPacketLifecycleSpawnLock<T>(packetId: string | null, operation: () => Promise<T>): Promise<T> {
  const key = packetId?.trim();
  if (!key || heldLifecyclePackets.getStore()?.get(key)?.active) return operation();
  const lease = await acquireWorkspaceLifecycleLease(key, { waitForLiveOwner: false });
  const authority: LifecycleAuthority = { active: true };
  try {
    return await heldLifecyclePackets.run(new Map([...(heldLifecyclePackets.getStore() ?? []), [key, authority]]), operation);
  } finally {
    authority.active = false;
    releaseWorkspaceLifecycleLease(lease);
  }
}

/**
 * Keep current-mission routing and the outgoing current-to-registry handoff in
 * one in-process ordering domain. Callers may take the control lock and then a
 * registry lock while inside this barrier, but must never enter it while
 * already holding either lock.
 */
export function withMissionHandoffBarrier<T>(operation: () => Promise<T>): Promise<T> {
  return chainOnKey(missionHandoffChains, 'current-to-registry', operation);
}
