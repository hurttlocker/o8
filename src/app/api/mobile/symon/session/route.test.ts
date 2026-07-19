/**
 * Real-path mint test (reachability doctrine — drives the ACTUAL POST handler).
 *
 * The live app isn't reachable from a worktree, so per docs/symon-agent-mode.md
 * §Verification this evidences the mint assembly with the upstream OpenAI fetch +
 * the webview eval bridge mocked: the token body carries the SAME config the desk
 * session uses (instructions + tools + transcription), the desk session is
 * preempted, and the full structured error table (403/501/502/503) fires — the
 * route never throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  evalJs: vi.fn<(code: string) => Promise<{ result: string }>>(),
  resolveOpenAIKey: vi.fn(),
  resolveRealtimeAccess: vi.fn(),
}));

vi.mock('@/lib/mcp/o8-webview-client', () => ({
  O8WebviewClient: class {
    evalJs = h.evalJs;
  },
}));
vi.mock('@/lib/cortex/qa/llm/byok-keys', () => ({ resolveOpenAIKey: h.resolveOpenAIKey }));
vi.mock('@/lib/voice/realtime-access', () => ({ resolveRealtimeAccess: h.resolveRealtimeAccess }));

const { POST } = await import('./route');

function req(body = '{}') {
  return new NextRequest('http://localhost:3001/api/mobile/symon/session', {
    method: 'POST',
    headers: { host: 'localhost:3001', 'content-type': 'application/json' },
    body,
  });
}

/** Default bridge: desk NOT live, one tool published, voice=marin. */
function bridgeReady(deskWasLive = false) {
  h.evalJs.mockImplementation(async (code: string) => {
    if (code.includes('deskWasLive')) return { result: JSON.stringify({ deskWasLive }) };
    return { result: JSON.stringify({ ready: true, tools: [{ type: 'function', name: 'o8_status' }], voice: 'marin' }) };
  });
}

beforeEach(() => {
  // Reset ONLY these fns — not vi.clearAllMocks(), which would also wipe the
  // O8WebviewClient constructor's `() => ({ evalJs })` implementation.
  h.evalJs.mockReset();
  h.resolveOpenAIKey.mockReset();
  h.resolveRealtimeAccess.mockReset();
  delete (globalThis as { __o8BrowserAgentClient?: unknown }).__o8BrowserAgentClient;
  h.resolveOpenAIKey.mockResolvedValue('sk-test-key');
  h.resolveRealtimeAccess.mockResolvedValue({ mode: 'byok', available: true, reason: 'byok' });
  bridgeReady();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/mobile/symon/session — mint assembly + error table', () => {
  it('200: mints, and the token body carries the SAME config the desk session uses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ value: 'ek_test_secret', expires_at: 1_783_490_000 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(req());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.session.sessionId).toMatch(/^sym-/);
    expect(json.session.clientSecret).toBe('ek_test_secret');
    expect(json.session.model).toBe('gpt-realtime-2.1-mini');
    expect(json.session.voice).toBe('marin');
    expect(json.session.baseUrl).toBe('https://api.openai.com/v1/realtime');
    expect(json.session.expiresAt).toBe(1_783_490_000 * 1000); // seconds → ms
    expect(json.preempted).toBeNull();

    // Config parity: instructions + tools (+auto) + input transcription baked in.
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sentBody.session.instructions).toContain('You are Symon');
    // Phone-only superset: the desk tool set PLUS the client-rendered surface
    // tool, and the persona carries the surface-authoring guidance.
    expect(sentBody.session.instructions).toContain('render_surface');
    expect(sentBody.session.tools).toHaveLength(2);
    expect(
      sentBody.session.tools.map((t: { name?: string }) => t.name),
    ).toContain('render_surface');
    expect(sentBody.session.tool_choice).toBe('auto');
    expect(sentBody.session.audio.input.transcription.model).toBe('whisper-1');
    expect(sentBody.session.audio.output.voice).toBe('marin');
  });

  it('200 + preempted:"desk" when a desk-mic session was live (stopped first)', async () => {
    bridgeReady(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ value: 'ek', expires_at: 1 }) }));
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).preempted).toBe('desk');
  });

  it('403 locked when the entitlement excludes realtime', async () => {
    h.resolveRealtimeAccess.mockResolvedValue({ mode: 'locked', available: false, reason: 'add a key' });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('locked');
  });

  it('501 no_key when entitled (managed) but no BYOK key / proxy', async () => {
    h.resolveRealtimeAccess.mockResolvedValue({ mode: 'managed', available: false, reason: 'coming' });
    const res = await POST(req());
    expect(res.status).toBe(501);
    expect((await res.json()).error).toBe('no_key');
  });

  it('503 desktop_unavailable when the webview eval bridge is unreachable', async () => {
    h.evalJs.mockRejectedValue(new Error('ENOENT socket'));
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('desktop_unavailable');
  });

  it('502 mint_failed on an upstream OpenAI error (structured, not thrown)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'bad request' } }),
    }));
    const res = await POST(req());
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe('mint_failed');
    expect(json.detail).toContain('bad request');
  });
});
