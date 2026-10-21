import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  evalJs: vi.fn<(code: string) => Promise<{ result: string }>>(),
  queueEvalJs: vi.fn<(code: string) => Promise<void>>(),
  spawn: vi.fn<(request: NextRequest) => Promise<Response>>(),
}));

vi.mock('@/lib/mcp/o8-webview-client', () => ({
  O8WebviewClient: class {
    evalJs = mocks.evalJs;
    queueEvalJs = mocks.queueEvalJs;
  },
}));

vi.mock('@/lib/panel/api-port', () => ({
  getApiBase: () => 'http://127.0.0.1:47120',
}));
vi.mock('@/app/api/orchestrator/spawn-prompt/route', () => ({ POST: mocks.spawn }));

const { POST } = await import('./route');

function request(verb: string, args: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/canvas/intent', {
    method: 'POST',
    body: JSON.stringify({ verb, args, origin: 'symon' }),
  });
}

describe('/api/canvas/intent dispatch acknowledgement', () => {
  beforeEach(() => {
    mocks.evalJs.mockReset();
    mocks.queueEvalJs.mockReset();
    mocks.queueEvalJs.mockResolvedValue();
    mocks.spawn.mockReset();
    mocks.spawn.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));
    delete (globalThis as { __o8BrowserAgentClient?: unknown }).__o8BrowserAgentClient;
  });

  it.each([20, 50, '20', null].map((count) => [count]))('preserves count %j when forwarding outside the canvas', async (count) => {
    mocks.evalJs.mockResolvedValueOnce({ result: JSON.stringify({ ready: false, route: '/dashboard' }) });
    await POST(request('spawn-agents', { task: 'preserve count', count, repo: '/repo' }));
    expect(mocks.spawn).toHaveBeenCalledOnce();
    await expect(mocks.spawn.mock.calls[0][0].json()).resolves.toMatchObject({ count });
    expect(mocks.queueEvalJs).not.toHaveBeenCalled();
  });

  it('acknowledges spawn-agents as soon as its separate dispatch is queued', async () => {
    mocks.evalJs
      .mockResolvedValueOnce({
        result: JSON.stringify({ ready: true, route: '/preview/canvas-glass' }),
      });

    const response = await POST(request('spawn-agents', {
      task: 'repair the auth flow',
      count: 2,
      repo: '/Users/operator/o8',
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      accepted: true,
      verb: 'spawn-agents',
    });
    expect(mocks.evalJs).toHaveBeenCalledOnce();
    expect(mocks.evalJs.mock.calls[0][0]).not.toContain('dispatchEvent');
    expect(mocks.queueEvalJs).toHaveBeenCalledOnce();
    expect(mocks.queueEvalJs.mock.calls[0][0]).toContain("dispatchEvent(new CustomEvent('o8:canvas-intent'");
    expect(mocks.queueEvalJs.mock.calls[0][0]).not.toContain('__o8CanvasIntentLast');
  });

  it('keeps synchronous acknowledgement for canvas reads', async () => {
    mocks.evalJs
      .mockResolvedValueOnce({
        result: JSON.stringify({ ready: true, route: '/preview/canvas-glass' }),
      })
      .mockResolvedValueOnce({
        result: JSON.stringify({
          ready: true,
          route: '/preview/canvas-glass',
          ack: { verb: 'list', ok: true, note: '2 cards', data: { count: 2 } },
        }),
      });

    const response = await POST(request('list', {}));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      verb: 'list',
      data: { count: 2 },
    });
    expect(mocks.evalJs.mock.calls[1][0]).toContain('__o8CanvasIntentLast');
  });
});
