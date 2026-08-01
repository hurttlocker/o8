import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  evalJs: vi.fn(),
  getOrCreateWsToken: vi.fn(() => 'remote-machine-token'),
}));

vi.mock('@/lib/mcp/o8-webview-client', () => ({
  O8WebviewClient: class {
    evalJs = h.evalJs;
  },
}));
vi.mock('@/lib/ws-auth', () => ({ getOrCreateWsToken: h.getOrCreateWsToken }));

const { POST } = await import('./route');

function request(token?: string): NextRequest {
  return new NextRequest('http://127.0.0.1/api/symon/transport/tool', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      sessionId: 'sym-primary',
      callId: 'call-1',
      tool: 'agent_turn',
      args: { id: 't:101:1', title: 'MacBook work', prompt: 'Inspect the repo' },
    }),
  });
}

beforeEach(() => {
  h.evalJs.mockReset();
  h.evalJs.mockResolvedValue({
    result: JSON.stringify({ state: 'done', ok: true, result: { accepted: true } }),
  });
  delete (globalThis as { __o8SymonTransportClient?: unknown }).__o8SymonTransportClient;
});

describe('POST /api/symon/transport/tool', () => {
  it('rejects a bare loopback request before the preconfirmed tool bridge', async () => {
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: 'unauthorized' });
    expect(h.evalJs).not.toHaveBeenCalled();
  });

  it('relays an authenticated SSH transport request through the real route', async () => {
    const response = await POST(request('remote-machine-token'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: { accepted: true } });
    expect(h.evalJs).toHaveBeenCalledOnce();
    expect(h.evalJs.mock.calls[0][0]).toContain('A.invokeTransportedTool');
  });
});
