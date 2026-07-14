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

import { fetchOnce } from './fetch-cache';

beforeEach(() => {
  mockIpcFetch.mockReset();
});

describe('fetchOnce dedup window', () => {
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
});
