/**
 * Realtime mint model gate, driven through the REAL desk route handlers (#2165).
 *
 * `POST /v1/realtime/client_secrets` mints a token for model ids the realtime
 * transport later refuses, so a bad constant looks healthy at the mint and only
 * fails at the SDP exchange with nothing naming the model. Per the reachability
 * rule these cases invoke the actual route handlers with a constructed Request
 * — not `assertRealtimeCapableModel` in isolation, which would prove the guard
 * works while saying nothing about whether either mint calls it.
 *
 * Hermetic by construction (no process, socket, or git fixture) — it belongs in
 * the fast suite, so the filename deliberately avoids the `-real-path` token
 * that routes a file to the resource-owning runner. The mobile mint's own
 * route.test.ts follows the same convention.
 *
 * The BYOK access path is mocked to its HAPPY state on purpose: the only thing
 * standing between the request and OpenAI is the model gate, so "fetch was
 * never called" is evidence about the gate and nothing else. The allow-listed
 * control case proves the gate can still let a mint through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { REALTIME_MODEL, REALTIME_CAPABLE_MODELS } from '@/lib/voice/realtime-session-config';

const h = vi.hoisted(() => ({
  resolveOpenAIKey: vi.fn(),
  resolveRealtimeAccess: vi.fn(),
}));

vi.mock('@/lib/cortex/qa/llm/byok-keys', () => ({ resolveOpenAIKey: h.resolveOpenAIKey }));
vi.mock('@/lib/voice/realtime-access', () => ({ resolveRealtimeAccess: h.resolveRealtimeAccess }));

const session = await import('@/app/api/voice/realtime/session/route');
const sdp = await import('@/app/api/voice/realtime/sdp/route');

const OFFER_SDP = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n';

/** Loopback Host — the same in-handler trust the desk webview arrives with. */
function req(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost:3001${path}`, {
    method: 'POST',
    headers: { host: 'localhost:3001', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.resolveOpenAIKey.mockReset();
  h.resolveRealtimeAccess.mockReset();
  h.resolveOpenAIKey.mockResolvedValue('sk-test-key');
  h.resolveRealtimeAccess.mockResolvedValue({ mode: 'byok', available: true, reason: 'byok' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/voice/realtime/session — model gate', () => {
  it('400s a non-realtime model, names it, and never reaches OpenAI', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await session.POST(req('/api/voice/realtime/session', { model: 'gpt-live-1' }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe('unsupported_realtime_model');
    expect(json.detail).toContain('gpt-live-1');
    expect(json.detail).toContain(REALTIME_MODEL);
    // The desk client reads `reason` for the message it shows the operator.
    expect(json.reason).toBe(json.detail);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets every allow-listed model through to the mint', async () => {
    for (const model of REALTIME_CAPABLE_MODELS) {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ value: 'ek_test_secret', expires_at: 1 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await session.POST(req('/api/voice/realtime/session', { model }));

      expect(res.status).toBe(200);
      expect((await res.json()).model).toBe(model);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).session.model).toBe(model);
    }
  });
});

describe('POST /api/voice/realtime/sdp — model gate', () => {
  it('400s a non-realtime model before minting or exchanging SDP', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await sdp.POST(req('/api/voice/realtime/sdp', { sdp: OFFER_SDP, model: 'gpt-live-1' }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('unsupported_realtime_model');
    expect(json.detail).toContain('gpt-live-1');
    expect(json.reason).toBe(json.detail);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('400s a typo of the shipping model id — the near-miss this gate exists for', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const typo = `${REALTIME_MODEL}i`;

    const res = await sdp.POST(req('/api/voice/realtime/sdp', { sdp: OFFER_SDP, model: typo }));

    expect(res.status).toBe(400);
    expect((await res.json()).detail).toContain(typo);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still relays an allow-listed model through mint + SDP exchange', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ value: 'ek_test_secret' }) })
      .mockResolvedValueOnce({ ok: true, text: async () => 'v=0\r\na=answer\r\n' });
    vi.stubGlobal('fetch', fetchMock);

    const res = await sdp.POST(req('/api/voice/realtime/sdp', { sdp: OFFER_SDP, model: REALTIME_MODEL }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.model).toBe(REALTIME_MODEL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
