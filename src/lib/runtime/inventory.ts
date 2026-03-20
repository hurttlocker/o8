import type { FleetSnapshot } from '@/lib/fleet/types';
import { getOpenClawFleetSnapshot } from '@/lib/openclaw/fleet';
const RUNTIME_INVENTORY_TTL_MS = 35_000;
const runtimeInventoryCache = new Map<'smart' | 'all', { snapshot: FleetSnapshot; cachedAt: number }>();
const runtimeInventoryInflight = new Map<'smart' | 'all', { generation: number; promise: Promise<FleetSnapshot> }>();
let runtimeInventoryGeneration = 0;

export function invalidateRuntimeInventoryCache() {
  runtimeInventoryGeneration += 1;
  runtimeInventoryCache.clear();
  runtimeInventoryInflight.clear();
}

export async function getRuntimeInventorySnapshot(
  options: { fleetMode?: 'smart' | 'all'; fresh?: boolean } = {},
): Promise<FleetSnapshot> {
  const fleetMode = options.fleetMode ?? 'smart';
  const fresh = options.fresh ?? false;
  const now = Date.now();
  const generation = runtimeInventoryGeneration;

  if (!fresh) {
    const cached = runtimeInventoryCache.get(fleetMode);
    if (cached && (now - cached.cachedAt) < RUNTIME_INVENTORY_TTL_MS) {
      return cached.snapshot;
    }

    const inflight = runtimeInventoryInflight.get(fleetMode);
    if (inflight && inflight.generation === generation) return inflight.promise;
  }

  const promise = (async () => {
    const snapshot = await getOpenClawFleetSnapshot({ fleetMode, fresh });

    const canCache = snapshot.meta.mode === 'live'
      && snapshot.meta.gatewayFreshness === 'fresh'
      && !snapshot.meta.observablePending;
    if (generation === runtimeInventoryGeneration && canCache) {
      runtimeInventoryCache.set(fleetMode, { snapshot, cachedAt: Date.now() });
    }
    return snapshot;
  })();

  runtimeInventoryInflight.set(fleetMode, { generation, promise });
  return promise.finally(() => {
    const current = runtimeInventoryInflight.get(fleetMode);
    if (current?.promise === promise) {
      runtimeInventoryInflight.delete(fleetMode);
    }
  });
}
