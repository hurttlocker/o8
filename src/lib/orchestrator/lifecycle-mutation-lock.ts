import { chainOnKey } from '@/lib/util/keyed-promise-chain';

const packetLifecycleChains = new Map<string, Promise<unknown>>();
const packetLifecycleDepth = new Map<string, number>();
const missionHandoffChains = new Map<string, Promise<unknown>>();

export interface PacketLifecycleMutationContext {
  /** Another lifecycle mutation for this packet was already queued or running. */
  contended: boolean;
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
    return await chainOnKey(packetLifecycleChains, key, () => mutation({ contended }));
  } finally {
    const remaining = (packetLifecycleDepth.get(key) ?? 1) - 1;
    if (remaining > 0) packetLifecycleDepth.set(key, remaining);
    else packetLifecycleDepth.delete(key);
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
