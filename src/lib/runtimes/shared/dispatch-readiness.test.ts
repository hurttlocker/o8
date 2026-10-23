import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isDispatchBackendReady,
  DispatchBackendNotReadyError,
  waitForDispatchBackendReady,
  type DispatchBackendReadiness,
} from './dispatch-readiness';

describe('dispatch backend readiness', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.unstubAllEnvs();
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

  it('retains a safe transport code and the resolved endpoint without leaking error text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('private request detail', {
      cause: Object.assign(new Error('private socket detail'), { code: 'ECONNREFUSED' }),
    })));
    const check = await isDispatchBackendReady();
    expect(check).toMatchObject({ ready: false, reason: 'fetch_failed', transportCode: 'ECONNREFUSED' });
    const error = new DispatchBackendNotReadyError({
      ready: false, reason: check.reason, waitedMs: 20_000, attempts: 10, lastCheck: check,
    });
    expect(error.message).toContain(`${check.apiBase}/api/setup/status`);
    expect(error.message).toContain('ECONNREFUSED');
    expect(error.message).toContain('dispatch_backend_not_ready');
    expect(error.message).not.toMatch(/warming|private/);
  });

  it('does not copy arbitrary transport error codes into diagnostics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private', {
      cause: { code: 'private-token-value' },
    })));
    const check = await isDispatchBackendReady();
    expect(check).not.toHaveProperty('transportCode');
    expect(JSON.stringify(check)).not.toContain('private');
  });

  it('finishes at the deadline even if a probe ignores its abort signal', async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    const result = waitForDispatchBackendReady({
      maxWaitMs: 50, probeTimeoutMs: 500, check: () => new Promise(() => {}),
    }).then(settled);
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({
      ready: false, reason: 'timeout', waitedMs: 50, attempts: 1,
    }));
    await result;
  });

  it('caps the final probe to the time left in the overall deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    })));
    const settled = vi.fn();
    const result = waitForDispatchBackendReady({ maxWaitMs: 50, probeTimeoutMs: 35, stepMs: 10 }).then(settled);
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ready: false, waitedMs: 50, attempts: 2 }));
    await result;
  });

  it('ignores an affirmative response that arrives after the launch deadline', async () => {
    vi.useFakeTimers();
    const result = waitForDispatchBackendReady({
      maxWaitMs: 50, probeTimeoutMs: 100,
      check: () => new Promise((resolve) => setTimeout(() => resolve({ ...coldCheck('http_200'), ready: true }), 60)),
    });
    await vi.advanceTimersByTimeAsync(50);
    const refused = await result;
    await vi.advanceTimersByTimeAsync(10);
    expect(refused).toMatchObject({ ready: false, reason: 'timeout', waitedMs: 50 });
  });

  it('does not attribute an older transport failure to a later probe timeout', async () => {
    vi.useFakeTimers();
    const check = vi.fn()
      .mockResolvedValueOnce({ ...coldCheck('fetch_failed'), transportCode: 'ECONNREFUSED' })
      .mockImplementationOnce(() => new Promise(() => {}));
    const result = waitForDispatchBackendReady({ maxWaitMs: 50, stepMs: 10, check });
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ ready: false, reason: 'timeout' });
    expect((await result).lastCheck.transportCode).toBeUndefined();
  });

  it('records the current attempted endpoint when a port changes before a hung probe', async () => {
    vi.useFakeTimers();
    vi.stubEnv('O8_API_PORT', '53001');
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))
      .mockImplementationOnce(() => new Promise(() => {})));
    const result = waitForDispatchBackendReady({ maxWaitMs: 50, probeTimeoutMs: 100, stepMs: 10 });
    setTimeout(() => vi.stubEnv('O8_API_PORT', '53002'), 5);
    await vi.advanceTimersByTimeAsync(50);
    expect((await result).lastCheck).toMatchObject({ apiBase: 'http://127.0.0.1:53002', reason: 'timeout' });
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
