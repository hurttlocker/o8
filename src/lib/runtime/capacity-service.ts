import { getAllRuntimes } from '@/lib/runtimes';
import type { RuntimeCapacitySnapshot } from '@/lib/runtimes/types';
import {
  listPublicRuntimeIdentities,
  type PublicRuntimeIdentity,
} from './identity-catalog';

export const CAPACITY_CACHE_MS = 15_000;
export const CAPACITY_OBSERVATION_TIMEOUT_MS = 5_000;

export interface RuntimeCapacityCapabilityProjection {
  runtime: string;
  identitySelection: boolean;
  identitySelectionReason: string | null;
}

export interface RuntimeCapacityControlSnapshot {
  schema: 'o8/runtime-capacity-control/v1';
  generatedAt: number;
  capacities: RuntimeCapacitySnapshot[];
  identities: PublicRuntimeIdentity[];
  runtimes: RuntimeCapacityCapabilityProjection[];
}

let cached: { value: RuntimeCapacityControlSnapshot; cachedAt: number } | null = null;
let inflight: Promise<RuntimeCapacityControlSnapshot> | null = null;
let capacityGeneration = 0;

function unavailable(runtime: string, reason: string, identityId: string | null = null): RuntimeCapacitySnapshot {
  return {
    runtime,
    identityId,
    status: 'unavailable',
    reason,
    observedAt: null,
    source: null,
    confidence: null,
    buckets: [],
  };
}

async function boundedCapacity(
  runtime: ReturnType<typeof getAllRuntimes>[number],
  identityId: string | null = null,
): Promise<RuntimeCapacitySnapshot> {
  if (!runtime.getCapacity) return unavailable(runtime.id, 'adapter_observation_unavailable', identityId);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(runtime.getCapacity(identityId)),
      new Promise<RuntimeCapacitySnapshot>((resolve) => {
        timeout = setTimeout(
          () => resolve(unavailable(runtime.id, 'observation_timeout', identityId)),
          CAPACITY_OBSERVATION_TIMEOUT_MS,
        );
        timeout.unref?.();
      }),
    ]);
  } catch {
    return unavailable(runtime.id, 'observation_failed', identityId);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function buildSnapshot(): Promise<RuntimeCapacityControlSnapshot> {
  const runtimes = getAllRuntimes().filter((runtime) => runtime.capabilities.capacity?.observe);
  const identities = await listPublicRuntimeIdentities();
  const observedCapacities = await Promise.all(runtimes.flatMap((runtime) => {
    const runtimeIdentities = runtime.capabilities.capacity?.identitySelection
      ? identities.filter((identity) => identity.runtime === runtime.id)
      : [];
    return runtimeIdentities.length > 0
      ? [
          boundedCapacity(runtime),
          ...runtimeIdentities.map((identity) => boundedCapacity(runtime, identity.id)),
        ]
      : [boundedCapacity(runtime)];
  }));
  const capacities = [...new Map(observedCapacities.map((capacity) => [
    `${capacity.runtime}:${capacity.identityId ?? 'default'}`,
    capacity,
  ])).values()];
  return {
    schema: 'o8/runtime-capacity-control/v1',
    generatedAt: Date.now(),
    capacities,
    identities,
    runtimes: runtimes.map((runtime) => ({
      runtime: runtime.id,
      identitySelection: runtime.capabilities.capacity?.identitySelection ?? false,
      identitySelectionReason: runtime.capabilities.capacity?.identitySelectionReason ?? null,
    })),
  };
}

export async function getRuntimeCapacityControlSnapshot(
  options: { fresh?: boolean } = {},
): Promise<RuntimeCapacityControlSnapshot> {
  const now = Date.now();
  if (!options.fresh && cached && now - cached.cachedAt < CAPACITY_CACHE_MS) return cached.value;
  if (inflight) return inflight;
  const generation = capacityGeneration;
  const promise = buildSnapshot().then((value) => {
    if (generation === capacityGeneration) cached = { value, cachedAt: Date.now() };
    return value;
  }).finally(() => {
    if (inflight === promise) inflight = null;
  });
  inflight = promise;
  return promise;
}

export function invalidateRuntimeCapacitySnapshot(): void {
  capacityGeneration += 1;
  cached = null;
  inflight = null;
}

export function resetRuntimeCapacityServiceForTests(): void {
  capacityGeneration += 1;
  cached = null;
  inflight = null;
}
