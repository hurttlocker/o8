import { describe, it, expect, vi, beforeEach } from 'vitest';

// Report D3YPBP (crash "Body is disturbed or locked" at clone@[native code]):
// fetchOnce handed the FIRST caller the original Response and later dedup
// hits a clone(). Once the first caller's res.json() disturbed the body,
// clone() threw as an unhandled rejection and silently killed the second
// caller's flow. The contract under test: every caller can read the body,
// regardless of who reads first, because every caller receives a clone of
// a never-read cached original.

const mockIpcFetch = vi.fn();
vi.mock('@/lib/tauri/ipc-fetch', () => ({
  ipcFetch: (...args: unknown[]) => mockIpcFetch(...args),
}));

import { fetchOnce, fetchSWRJson, invalidateFetchOnce } from './fetch-cache';

beforeEach(() => {
  mockIpcFetch.mockReset();
});

describe('fetchOnce dedup window', () => {
  it.each([
    new DOMException('Fetch is aborted', 'AbortError'),
    new TypeError('Failed to fetch'),
  ])('delivers a failed shared read to callers and permits an immediate retry: %s', async (error) => {
    const controller = new AbortController();
    mockIpcFetch.mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(error), { once: true });
    }));
    const url = `/api/panel/repos?rejected-read=${Math.random()}`;
    const key = `repos-rejection:${Math.random()}`;
    const reads = Promise.allSettled([
      fetchSWRJson(key, url, { signal: controller.signal }),
      fetchOnce(url),
    ]);
    controller.abort();
    expect(await reads).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ]);
    mockIpcFetch.mockResolvedValueOnce(Response.json({ repos: ['recovered'] }));
    await expect(fetchSWRJson(key, url)).resolves.toEqual({ repos: ['recovered'] });
    expect(mockIpcFetch).toHaveBeenCalledTimes(2);
    // Let orphaned promise rejections reach the runner, as they do the webview.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('lets every deduped caller read the body independently', async () => {
    mockIpcFetch.mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), {
      headers: { 'Content-Type': 'application/json' },
    }));

    const url = `/api/panel/status?t=${Math.random()}`;
    const [a, b, c] = await Promise.all([fetchOnce(url), fetchOnce(url), fetchOnce(url)]);

    // one underlying request…
    expect(mockIpcFetch).toHaveBeenCalledTimes(1);

    // …and EVERY caller reads successfully, in first-wins order too.
    await expect(a.json()).resolves.toEqual({ ok: 1 });
    await expect(b.json()).resolves.toEqual({ ok: 1 });
    await expect(c.json()).resolves.toEqual({ ok: 1 });
  });

  it('later dedup hit still reads after the first caller already consumed its body', async () => {
    mockIpcFetch.mockResolvedValue(new Response(JSON.stringify({ ok: 2 }), {
      headers: { 'Content-Type': 'application/json' },
    }));

    const url = `/api/panel/status?t=${Math.random()}`;
    const first = await fetchOnce(url);
    await first.json(); // disturb the first caller's response

    const second = await fetchOnce(url); // inside the 150ms window → dedup hit
    expect(mockIpcFetch).toHaveBeenCalledTimes(1);
    await expect(second.json()).resolves.toEqual({ ok: 2 });
  });

  it('joins an identical GET for its whole in-flight duration, not just 150ms', async () => {
    // Boot-storm coalescing (prod boot 2026-07-17): the same URL requested
    // seconds apart while the first request is still on the wire must JOIN
    // it — the old start-window check opened a new socket per call and
    // starved the webview's per-host pool (8-9.5s queue stalls measured).
    let release: (r: Response) => void = () => {};
    mockIpcFetch.mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));

    const url = `/api/runtime/inventory?t=${Math.random()}`;
    const first = fetchOnce(url);
    // Simulate a second call arriving well past the old 150ms window while
    // the first is still unresolved.
    await new Promise((r) => setTimeout(r, 200));
    const second = fetchOnce(url);

    release(new Response(JSON.stringify({ ok: 3 }), { headers: { 'Content-Type': 'application/json' } }));
    const [a, b] = await Promise.all([first, second]);
    expect(mockIpcFetch).toHaveBeenCalledTimes(1);
    await expect(a.json()).resolves.toEqual({ ok: 3 });
    await expect(b.json()).resolves.toEqual({ ok: 3 });
  });

  it('non-GET requests bypass the cache entirely', async () => {
    const realFetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', realFetch);
    try {
      await fetchOnce('/api/panel/thing', { method: 'POST' });
      expect(realFetch).toHaveBeenCalledTimes(1);
      expect(mockIpcFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a replacement read shared when an invalidated older request settles', async () => {
    vi.useFakeTimers();
    try {
      let releaseOld!: (response: Response) => void;
      let releaseFresh!: (response: Response) => void;
      mockIpcFetch
        .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseOld = resolve; }))
        .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseFresh = resolve; }));
      const url = '/api/panel/projects?replacement-read';
      const oldRead = fetchOnce(url);
      invalidateFetchOnce(url);
      const freshRead = fetchOnce(url);
      releaseOld(Response.json({ revision: 'old' }));
      await oldRead;
      await vi.advanceTimersByTimeAsync(151);
      const joiningRead = fetchOnce(url);
      expect(mockIpcFetch).toHaveBeenCalledTimes(2);
      releaseFresh(Response.json({ revision: 'fresh' }));
      const responses = await Promise.all([freshRead, joiningRead]);
      expect(await Promise.all(responses.map((response) => response.json())))
        .toEqual([{ revision: 'fresh' }, { revision: 'fresh' }]);
      await vi.advanceTimersByTimeAsync(151);
    } finally {
      vi.useRealTimers();
    }
  });
});
