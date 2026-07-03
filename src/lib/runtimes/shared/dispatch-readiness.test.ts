import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isDispatchBackendReady,
  waitForDispatchBackendReady,
  type DispatchBackendReadiness,
} from './dispatch-readiness';

describe('dispatch backend readiness', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports ready when the setup status probe returns 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await isDispatchBackendReady();

    expect(result.ready).toBe(true);
    expect(result.reason).toBe('http_200');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/setup\/status$/),
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('reports not ready for non-200 and timeout probe results', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(isDispatchBackendReady()).resolves.toMatchObject({
      ready: false,
      reason: 'http_500',
      status: 500,
    });
    await expect(isDispatchBackendReady()).resolves.toMatchObject({
      ready: false,
      reason: 'timeout',
    });
  });

  it('retries cold probes until the backend becomes ready', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const checks: DispatchBackendReadiness[] = [
      coldCheck('http_500'),
      coldCheck('timeout'),
      { ...coldCheck('http_200'), ready: true, status: 200 },
    ];

    const result = await waitForDispatchBackendReady({
      maxWaitMs: 50,
      stepMs: 10,
      check: async () => checks.shift() ?? coldCheck('unexpected'),
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      now: () => now,
    });

    expect(result).toMatchObject({
      ready: true,
      waitedMs: 20,
      attempts: 3,
      reason: 'http_200',
    });
    expect(sleeps).toEqual([10, 10]);
  });
});

function coldCheck(reason: string): DispatchBackendReadiness {
  return {
    ready: false,
    reason,
    apiBase: 'http://o8.test',
    portSource: 'default',
    apiPortFilePresent: false,
  };
}
