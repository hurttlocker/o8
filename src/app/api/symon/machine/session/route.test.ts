import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ evalJs: vi.fn() }));

vi.mock('@/lib/mcp/o8-webview-client', () => ({
  O8WebviewClient: class {
    evalJs = h.evalJs;
  },
}));

const { POST } = await import('./route');

function request(sessionId: unknown): NextRequest {
  return new NextRequest('http://127.0.0.1/api/symon/machine/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
}

beforeEach(() => {
  h.evalJs.mockReset();
  h.evalJs.mockResolvedValue({ result: JSON.stringify({ state: 'done', removed: true }) });
  delete (globalThis as { __o8SymonMachineSessionClient?: unknown }).__o8SymonMachineSessionClient;
});

describe('POST /api/symon/machine/session', () => {
  it('ends the native machine session through the real webview bridge route', async () => {
    const response = await POST(request('sym-ended'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, removed: true });
    expect(h.evalJs).toHaveBeenCalledOnce();
    expect(h.evalJs.mock.calls[0][0]).toContain('A.endMachineSession(sessionId)');
    expect(h.evalJs.mock.calls[0][0]).toContain('const sessionId = "sym-ended"');
  });

  it('rejects an unbounded session id before reaching the bridge', async () => {
    const response = await POST(request('x'.repeat(161)));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: 'bad_request' });
    expect(h.evalJs).not.toHaveBeenCalled();
  });
});
