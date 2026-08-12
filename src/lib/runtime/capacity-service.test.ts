import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeFixture = vi.hoisted(() => ({
  runtimes: [] as Array<Record<string, unknown>>,
  identities: [] as Array<{ id: string; runtime: string; label: string; selected: boolean }>,
}));

vi.mock('@/lib/runtimes', () => ({
  getAllRuntimes: () => runtimeFixture.runtimes,
}));

vi.mock('./identity-catalog', () => ({
  listPublicRuntimeIdentities: vi.fn(async () => runtimeFixture.identities),
}));

import {
  CAPACITY_OBSERVATION_TIMEOUT_MS,
  getRuntimeCapacityControlSnapshot,
  resetRuntimeCapacityServiceForTests,
} from './capacity-service';

afterEach(() => {
  vi.useRealTimers();
  runtimeFixture.runtimes = [];
  runtimeFixture.identities = [];
  resetRuntimeCapacityServiceForTests();
});

describe('runtime capacity service bounds', () => {
  it('coalesces refreshes and times out one stuck adapter without a process loop', async () => {
    vi.useFakeTimers();
    const observe = vi.fn(() => new Promise(() => {}));
    runtimeFixture.runtimes = [{
      id: 'stuck-runtime',
      capabilities: { capacity: { observe: true, identitySelection: false } },
      getCapacity: observe,
    }];

    const first = getRuntimeCapacityControlSnapshot({ fresh: true });
    const second = getRuntimeCapacityControlSnapshot({ fresh: true });
    await vi.advanceTimersByTimeAsync(CAPACITY_OBSERVATION_TIMEOUT_MS);
    const [left, right] = await Promise.all([first, second]);

    expect(observe).toHaveBeenCalledTimes(1);
    expect(left).toBe(right);
    expect(left.capacities).toEqual([expect.objectContaining({
      runtime: 'stuck-runtime',
      status: 'unavailable',
      reason: 'observation_timeout',
    })]);
  });

  it('observes each registered identity without changing the selected identity', async () => {
    const observe = vi.fn(async (identityId?: string | null) => ({
      runtime: 'multi-runtime',
      identityId: identityId ?? null,
      status: 'available' as const,
      reason: null,
      observedAt: new Date().toISOString(),
      source: 'local-state' as const,
      confidence: 'exact' as const,
      buckets: [],
    }));
    runtimeFixture.runtimes = [{
      id: 'multi-runtime',
      capabilities: { capacity: { observe: true, identitySelection: true } },
      getCapacity: observe,
    }];
    runtimeFixture.identities = [
      { id: 'identity-a', runtime: 'multi-runtime', label: 'A', selected: false },
      { id: 'identity-b', runtime: 'multi-runtime', label: 'B', selected: true },
    ];

    const snapshot = await getRuntimeCapacityControlSnapshot({ fresh: true });

    expect(observe).toHaveBeenCalledTimes(3);
    expect(observe).toHaveBeenNthCalledWith(1, null);
    expect(observe).toHaveBeenNthCalledWith(2, 'identity-a');
    expect(observe).toHaveBeenNthCalledWith(3, 'identity-b');
    expect(snapshot.capacities.map((capacity) => capacity.identityId)).toEqual([null, 'identity-a', 'identity-b']);
  });

  it('keeps failing identities distinct and observes the default until an identity is selected', async () => {
    const observe = vi.fn(async (identityId?: string | null) => {
      if (identityId) throw new Error('provider unavailable');
      return {
        runtime: 'multi-runtime',
        identityId: null,
        status: 'available' as const,
        reason: null,
        observedAt: new Date().toISOString(),
        source: 'local-state' as const,
        confidence: 'exact' as const,
        buckets: [],
      };
    });
    runtimeFixture.runtimes = [{
      id: 'multi-runtime',
      capabilities: { capacity: { observe: true, identitySelection: true } },
      getCapacity: observe,
    }];
    runtimeFixture.identities = [
      { id: 'identity-a', runtime: 'multi-runtime', label: 'A', selected: false },
      { id: 'identity-b', runtime: 'multi-runtime', label: 'B', selected: false },
    ];

    const snapshot = await getRuntimeCapacityControlSnapshot({ fresh: true });

    expect(observe).toHaveBeenCalledTimes(3);
    expect(snapshot.capacities).toEqual([
      expect.objectContaining({ identityId: null, status: 'available' }),
      expect.objectContaining({ identityId: 'identity-a', status: 'unavailable' }),
      expect.objectContaining({ identityId: 'identity-b', status: 'unavailable' }),
    ]);
  });
});
