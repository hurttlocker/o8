import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  evalJs: vi.fn(),
}));

vi.mock('@/lib/mcp/o8-webview-client', () => ({
  O8WebviewClient: class {
    evalJs = mocks.evalJs;
  },
}));

vi.mock('@/lib/browser-engine/engine', () => ({
  getBrowserEngine: () => ({ hasSession: () => false }),
}));

vi.mock('@/lib/lane/events', () => ({ recordLaneEvent: vi.fn() }));
vi.mock('@/lib/lane/registry', () => ({ findLatestLaneByPacket: vi.fn(() => null) }));

const { POST } = await import('./route');

function request(verb: string, args: Record<string, unknown>) {
  return new NextRequest('http://localhost:3001/api/browser/agent', {
    method: 'POST',
    body: JSON.stringify({ verb, args }),
  });
}

describe('/api/browser/agent localization verbs', () => {
  beforeEach(() => {
    mocks.evalJs.mockReset();
  });

  it('drives localize through the real iframe-agent route', async () => {
    const envelope = {
      ok: true,
      surface: 'canvas',
      coordinateSpace: 'host-viewport',
      viewport: { width: 1200, height: 800 },
      interactive: [{ selector: '#save', tag: 'button', label: 'Save', rect: { left: 10, top: 20, width: 80, height: 30 } }],
    };
    mocks.evalJs.mockResolvedValue({ result: JSON.stringify(envelope) });

    const response = await POST(request('localize', { surface: 'canvas' }));
    expect(await response.json()).toEqual(envelope);
    expect(mocks.evalJs).toHaveBeenCalledOnce();
    expect(mocks.evalJs.mock.calls[0][0]).toContain('.localize(');
  });

  it('drives an exact selector rect through the same production route', async () => {
    const envelope = {
      ok: true,
      surface: 'canvas',
      coordinateSpace: 'host-viewport',
      viewport: { width: 1200, height: 800 },
      selector: '#save',
      tag: 'button',
      label: 'Save',
      rect: { left: 10, top: 20, width: 80, height: 30 },
    };
    mocks.evalJs.mockResolvedValue({ result: JSON.stringify(envelope) });

    const response = await POST(request('rect', { surface: 'canvas', selector: '#save' }));
    expect(await response.json()).toEqual(envelope);
    expect(mocks.evalJs.mock.calls[0][0]).toContain('.rect(');
  });

  it('pulls native-child localization through browser_view_eval_result', async () => {
    const envelope = {
      ok: true,
      surface: 'native',
      coordinateSpace: 'page-viewport',
      viewport: { width: 900, height: 600 },
      interactive: [],
    };
    mocks.evalJs.mockResolvedValue({
      result: JSON.stringify({ open: true, result: JSON.stringify(envelope) }),
    });

    const response = await POST(request('localize', { surface: 'panel' }));
    expect(await response.json()).toEqual(envelope);
    expect(mocks.evalJs.mock.calls[0][0]).toContain('browser_view_eval_result');
    expect(mocks.evalJs.mock.calls[0][0]).toContain('.localize(');
  });
});
