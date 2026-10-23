import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/ws-auth', () => ({ getOrCreateWsToken: () => 'fixture-operator-token' }));
const upstream = vi.fn<typeof fetch>();
beforeEach(() => { upstream.mockReset().mockResolvedValue(Response.json({ ok: true })); vi.stubGlobal('fetch', upstream); });
afterEach(() => vi.unstubAllGlobals());
async function submit(body: unknown, host = '127.0.0.1') {
  const { POST } = await import('./route');
  return POST(new NextRequest('http://127.0.0.1/api/panel/release-notes', {
    method: 'POST', headers: { host, 'Content-Type': 'application/json', authorization: 'Bearer unrelated-account-token' }, body: JSON.stringify(body),
  }));
}

it('forwards only email and app provenance to the existing list without caller credentials', async () => {
  const response = await submit({ email: ' reader@example.invalid ', source: 'other', repoPath: '/fixture/private', token: 'fixture-private-value' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(upstream).toHaveBeenCalledTimes(1);
  const [url, init] = upstream.mock.calls[0];
  expect(url).toBe('https://o8.run/api/subscribe');
  expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' });
  expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(JSON.parse(String(init?.body))).toEqual({ email: 'reader@example.invalid', source: 'app' });
  expect(init?.signal).toBeInstanceOf(AbortSignal);
});

it.each([null, [], {}, { email: 42 }, { email: 'invalid' }, { email: 'a'.repeat(255) + '@example.invalid' }])('rejects invalid email input before external access: %j', async (body) => {
  const response = await submit(body);
  expect(response.status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});

it('rejects unauthenticated non-loopback callers before contacting the list', async () => {
  const response = await submit({ email: 'reader@example.invalid' }, 'remote.invalid');
  expect(response.status).toBe(401);
  expect(upstream).not.toHaveBeenCalled();
});

it('rejects malformed JSON without throwing or making a request', async () => {
  const { POST } = await import('./route');
  const response = await POST(new NextRequest('http://127.0.0.1/api/panel/release-notes', {
    method: 'POST', headers: { host: '127.0.0.1' }, body: '{',
  }));
  expect(response.status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});

it.each([
  [200, { ok: false, reason: 'not_configured' }, 503, 'Signups are paused. Please try again later.'],
  [502, { message: 'fixture-private-value' }, 502, 'Could not subscribe. Please try again.'],
  [200, { ok: 'true' }, 502, 'Could not subscribe. Please try again.'],
])('reports upstream failure truthfully without reflecting arbitrary content: %s %j', async (status, body, expectedStatus, error) => {
  upstream.mockResolvedValueOnce(Response.json(body, { status }));
  const response = await submit({ email: 'reader@example.invalid' });
  expect(response.status).toBe(expectedStatus);
  expect(await response.json()).toEqual({ ok: false, error });
});

it('handles unavailable transport without exposing the address or transport details', async () => {
  upstream.mockRejectedValueOnce(new Error('fixture-private-value'));
  const response = await submit({ email: 'reader@example.invalid' });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ ok: false, error: 'Could not subscribe. Please try again.' });
});
