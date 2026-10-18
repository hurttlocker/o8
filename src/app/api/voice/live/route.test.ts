import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/auth/principal', () => ({ resolveRequestPrincipal: (request: Request) => request.headers.get('x-role') ?? 'operator' }));
vi.mock('@/lib/cortex/qa/llm/inference-route', () => ({ planToken: () => 'signed-plan-fixture', proxyBaseUrl: () => 'https://gateway.fixture' }));
import { GET, POST } from './route';
const request = (body: unknown, token = 'operator-fixture', role = 'operator') => new Request('http://localhost/api/voice/live', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-role': role }, body: JSON.stringify(body),
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('managed voice application relay', () => {
  it('rejects null and array bodies without throwing', async () => {
    for (const value of [null, [], 2, 'text']) expect((await POST(request(value))).status).toBe(400);
  });
  it('blocks worker/anonymous callers before any funded operation', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1');
    for (const role of ['worker', 'anonymous', 'spectator']) expect((await POST(request({ action: 'start' }, 'x', role))).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('is disabled unless opted in', async () => {
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '0');
    expect((await GET(request({}))).status).toBe(200);
    expect((await POST(request({ action: 'start' }))).status).toBe(503);
  });
  it('keeps plan token server-side and controls bound to exact principal and conversation', async () => {
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1');
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ id: 'owned-session', sdp: 'v=0\nanswer' })); vi.stubGlobal('fetch', fetch);
    const started = await POST(request({ action: 'start', binding: 'repo:thread:claude', context: 'history', sdp: 'v=0\noffer' }));
    expect(started.status).toBe(200); expect(await started.text()).not.toContain('signed-plan-fixture');
    expect(fetch.mock.calls[0]![0]).toBe('https://gateway.fixture/v1/live/sessions');
    expect((await POST(request({ action: 'close', id: 'owned-session', binding: 'repo:thread:claude' }, 'other'))).status).toBe(404);
    expect((await POST(request({ action: 'close', id: 'owned-session', binding: 'different-thread' }))).status).toBe(404);
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '0');
    expect((await POST(request({ action: 'close', id: 'owned-session', binding: 'repo:thread:claude' }))).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
