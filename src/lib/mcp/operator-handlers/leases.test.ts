import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  handleLeaseAcquire,
  handleLeaseList,
  handleLeaseRelease,
  handleLeaseStatus,
} from './leases';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function resultText(result: Awaited<ReturnType<typeof handleLeaseAcquire>>): string {
  const content = result.content[0];
  return content?.type === 'text' ? content.text : '';
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resource lease MCP handlers', () => {
  it('keeps one waiter id while polling a durable FIFO queue', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let requestCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      requestCount += 1;
      return requestCount === 1
        ? jsonResponse({ ok: false, result: { state: 'queued', waiter: { position: 1 } } }, 202)
        : jsonResponse({ ok: true, result: { state: 'acquired', lease: { resource: 'full-suite' } } });
    }));

    const result = await handleLeaseAcquire({ resource: 'full-suite', ttlMs: 30_000, wait: true });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(resultText(result))).toMatchObject({ result: { state: 'acquired' } });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      action: 'acquire',
      resource: 'full-suite',
      ttlMs: 30_000,
      wait: true,
      owner: { pid: process.pid },
      claimToken: expect.stringMatching(/^[A-Za-z0-9_-]{32,256}$/),
      waiterPid: process.pid,
    });
    expect(bodies[1]?.waiterId).toBe(bodies[0]?.waiterId);
  });

  it('surfaces structured holder conflicts as tool errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ok: true,
      result: { state: 'acquired', lease: { resource: 'repo-tree:/repo' } },
    })));
    await handleLeaseAcquire({ resource: 'repo-tree:/repo' });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ok: false,
      result: {
        released: false,
        refusal: { code: 'not_owner', holder: { owner: { id: 'current-holder' } } },
      },
    }, 409)));

    const result = await handleLeaseRelease({ resource: 'repo-tree:/repo' });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('current-holder');
  });

  it('fails closed instead of polling an unrecognized waiter state', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: false, result: {} }, 202));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleLeaseAcquire({ resource: 'full-suite', wait: true });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('no recognized lease state');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps status and list reads onto the named lease route', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return jsonResponse({ ok: true, leases: [] });
    }));

    const status = await handleLeaseStatus({ resource: 'test-suite:repo:full-serial' });
    const list = await handleLeaseList();

    expect(status.isError).not.toBe(true);
    expect(list.isError).not.toBe(true);
    expect(urls[0]).toContain('/api/leases?resource=test-suite%3Arepo%3Afull-serial');
    expect(urls[1]).toMatch(/\/api\/leases$/);
  });
});
