import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const upstream = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
vi.mock('@/lib/github-broker/auth', () => ({ githubInstallationFetch: upstream.fetch }));

const OPERATOR = 'test-operator-0123456789abcdef';
const WORKER = 'test-worker-0123456789abcdef';
const DEVICE = 'test-device-0123456789abcdef';
const SPECTATOR = 'test-spectator-0123456789abcdef';
const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
writeFileSync(join(dataDir, 'ws-token'), OPERATOR);
writeFileSync(join(dataDir, 'worker-token'), WORKER);
writeFileSync(join(dataDir, 'mobile-device-tokens'), createHash('sha256').update(DEVICE).digest('hex'));
writeFileSync(join(dataDir, 'broadcast-spectator-tokens'), createHash('sha256').update(SPECTATOR).digest('hex'));
process.env.WS_TOKEN = OPERATOR;

const { panelGateMiddleware } = await import('@/middleware');
const { GET } = await import('@/app/api/panel/github-read/route');

function request(path = '/pulls?state=open&per_page=100', token = OPERATOR, extra = '') {
  const url = new URL('http://localhost:3001/api/panel/github-read');
  url.searchParams.set('repo', 'owner/project');
  url.searchParams.set('path', path);
  if (extra) url.searchParams.set('query', extra);
  return new NextRequest(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

function response(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return { installation: { id: 91 }, response: Response.json(data, { status, headers }) };
}

beforeEach(() => {
  upstream.fetch.mockReset();
  upstream.fetch.mockImplementation(async (_repo: string, path: string) => path === '/repos/owner/project'
    ? response({ full_name: 'owner/project', private: false })
    : response([]));
});

describe('GitHub App operator read route', () => {
  it.each(['', 'unknown', WORKER, DEVICE, SPECTATOR])('refuses non-operator bearer %s before upstream access', async (token) => {
    const req = request('/pulls', token);
    expect(panelGateMiddleware(req).status).toBe(!token || token === 'unknown' ? 401 : 403);
    expect((await GET(req)).status).toBe(403);
    expect(upstream.fetch).not.toHaveBeenCalled();
  });

  it('returns raw public data, status and only evidence headers without cache or credentials', async () => {
    upstream.fetch.mockResolvedValueOnce(response({ full_name: 'owner/project', private: false }));
    upstream.fetch.mockResolvedValueOnce(response([{ number: 7 }], 200, {
      link: '<https://api.github.com/repos/owner/project/pulls?state=open&per_page=100&page=2>; rel="next"',
      'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4987', 'x-ratelimit-reset': '1900000000',
      'x-ratelimit-resource': 'core', 'x-github-request-id': 'test-request',
      authorization: 'SECRET_SENTINEL', 'set-cookie': 'SECRET_SENTINEL',
    }));
    const req = request();
    expect(panelGateMiddleware(req).status).toBe(200);
    const res = await GET(req);
    const value = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(value).toMatchObject({ schema: 'o8/github-read/v1', ok: true, authSource: 'github-app',
      installationId: 91, repo: 'owner/project', response: { status: 200, data: [{ number: 7 }],
        headers: { 'x-ratelimit-remaining': '4987', 'x-github-request-id': 'test-request' } } });
    expect(value.response.headers.link).toContain('page=2');
    expect(JSON.stringify(value)).not.toContain('SECRET_SENTINEL');
    expect(upstream.fetch.mock.calls.every((call) => call[2]?.signal instanceof AbortSignal)).toBe(true);
    expect(upstream.fetch.mock.calls.every((call) => call[2]?.redirect === 'error')).toBe(true);
  });

  it.each([
    'https://api.github.com/repos/owner/project/pulls', '//pulls', '/pulls/../secrets',
    '/pulls%2F7', '/pulls/7/merge', '/actions/secrets', '/pulls?state=open&state=closed',
    '/pulls?token=hidden', '/pulls?per_page=101', '/pulls?per_page=100&page=11',
  ])('rejects unsafe endpoint %s without authenticating upstream', async (path) => {
    expect((await GET(request(path))).status).toBe(400);
    expect(upstream.fetch).not.toHaveBeenCalled();
  });

  it('rejects arbitrary GraphQL text', async () => {
    expect((await GET(request('/pulls', OPERATOR, 'mutation { deleteRepository }'))).status).toBe(400);
    expect(upstream.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { full_name: 'owner/project', private: true },
    { full_name: 'other/project', private: false },
  ])('withholds private or changed repository evidence', async (repository) => {
    upstream.fetch.mockResolvedValueOnce(response(repository));
    const res = await GET(request());
    expect(res.status).toBe(422);
    expect(upstream.fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves a rate-limit failure and retry metadata instead of returning empty success', async () => {
    upstream.fetch.mockResolvedValueOnce(response({ full_name: 'owner/project', private: false }));
    upstream.fetch.mockResolvedValueOnce(response({ message: 'API rate limit exceeded' }, 403, {
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000', 'retry-after': '60',
    }));
    const value = await (await GET(request())).json();
    expect(value).toMatchObject({ ok: true, response: { status: 403,
      data: { message: 'API rate limit exceeded' }, headers: { 'retry-after': '60' } } });
  });

  it('uses a fixed review-thread query with variables and preserves GraphQL errors', async () => {
    upstream.fetch.mockResolvedValueOnce(response({ full_name: 'owner/project', private: false }));
    upstream.fetch.mockResolvedValueOnce(response({ errors: [{ message: 'query unavailable' }] }));
    const url = new URL('http://localhost:3001/api/panel/github-read?repo=owner/project&kind=review-threads&number=7');
    const value = await (await GET(new NextRequest(url, { headers: { authorization: `Bearer ${OPERATOR}` } }))).json();
    expect(value.response.data.errors).toHaveLength(1);
    const options = upstream.fetch.mock.calls[1][2];
    const body = JSON.parse(options.body);
    expect(body.variables).toEqual({ owner: 'owner', name: 'project', number: 7, after: null });
    expect(body.query).toContain('reviewThreads(first:100,after:$after)');
    expect(options.method).toBe('POST');
  });

  it('withholds evidence if the installation changes within the operation', async () => {
    upstream.fetch.mockResolvedValueOnce(response({ full_name: 'owner/project', private: false }));
    upstream.fetch.mockResolvedValueOnce({ ...response([]), installation: { id: 92 } });
    expect((await GET(request())).status).toBe(409);
  });

  it('exposes only the fixed public ownership query and rejects caller arguments', async () => {
    const url = new URL('http://localhost:3001/api/panel/github-read?repo=owner/project&kind=ownership');
    const req = new NextRequest(url, { headers: { authorization: `Bearer ${OPERATOR}` } });
    expect((await GET(req)).status).toBe(200);
    const body = JSON.parse(upstream.fetch.mock.calls[1][2].body);
    expect(body.variables).toEqual({ owner: 'owner', name: 'project' });
    expect(body.query).toContain('pullRequests(states:OPEN,first:100)');
    url.searchParams.set('query', 'mutation { deleteRepository }');
    upstream.fetch.mockClear();
    expect((await GET(new NextRequest(url, { headers: { authorization: `Bearer ${OPERATOR}` } }))).status).toBe(400);
    expect(upstream.fetch).not.toHaveBeenCalled();
  });

  it('retains quota evidence when an upstream refusal has no JSON body', async () => {
    upstream.fetch.mockResolvedValueOnce({ installation: { id: 91 }, response: new Response('denied', {
      status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' },
    }) });
    const value = await (await GET(request())).json();
    expect(value.ok).toBe(false);
    expect(value.response.status).toBe(403);
    expect(value.response.headers['x-ratelimit-remaining']).toBe('0');
    expect(upstream.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not replace malformed or oversized upstream data with success', async () => {
    upstream.fetch.mockResolvedValueOnce(response({ full_name: 'owner/project', private: false }));
    upstream.fetch.mockResolvedValueOnce({ installation: { id: 91 }, response: new Response('x'.repeat(2_000_001)) });
    expect((await GET(request())).status).toBe(502);
  });

  it('aborts a stalled installation/read at the operation deadline', async () => {
    vi.useFakeTimers();
    try {
      upstream.fetch.mockImplementationOnce((_repo, _path, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }));
      const pending = GET(request());
      await vi.advanceTimersByTimeAsync(40_001);
      expect((await pending).status).toBe(504);
      expect(upstream.fetch.mock.calls[0][2].signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a stalled body and respects a shorter caller deadline', async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    try {
      upstream.fetch.mockResolvedValueOnce({ installation: { id: 91 }, response: new Response(new ReadableStream({ cancel: cancelled })) });
      const req = request();
      const url = new URL(req.url); url.searchParams.set('timeoutMs', '250');
      const pending = GET(new NextRequest(url, { headers: req.headers }));
      await vi.advanceTimersByTimeAsync(251);
      expect((await pending).status).toBe(504);
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(upstream.fetch).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
