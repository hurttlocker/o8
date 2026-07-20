import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  evalJs: vi.fn<(code: string) => Promise<{ result: string }>>(),
}));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/mcp/o8-webview-client', () => ({
  O8WebviewClient: class {
    evalJs = h.evalJs;
  },
}));

const { POST, buildConfirmEval } = await import('./route');

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/mobile/symon/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.evalJs.mockReset();
  delete (globalThis as { __o8BrowserAgentClient?: unknown }).__o8BrowserAgentClient;
});

describe('POST /api/mobile/symon/confirm', () => {
  it('addresses the exact tool slot and calls resolveConfirm once through a decision cache', () => {
    const code = buildConfirmEval({
      sessionId: 'session-1', callId: 'call-1', confirmationId: 'confirm-1', allow: true,
    });
    expect(code).toContain('JSON.stringify([sessionId, callId])');
    expect(code).toContain('slot.confirmationId !== confirmationId');
    expect(code).toContain('A.resolveConfirm(confirmationId, allow, { sessionId, callId })');
    expect(code).toContain('JSON.stringify([sessionId, callId, confirmationId])');
  });

  it('returns the Rust first-decision result', async () => {
    h.evalJs.mockResolvedValue({
      result: JSON.stringify({ state: 'done', resolution: { status: 'resolved', allow: true } }),
    });
    const response = await POST(request({
      sessionId: 'session-1', callId: 'call-1', confirmationId: 'confirm-1', allow: true,
    }));
    expect(await response.json()).toEqual({
      ok: true,
      resolution: { status: 'resolved', allow: true },
    });
  });

  it('preserves an already-resolved first decision for idempotent replay', async () => {
    h.evalJs.mockResolvedValue({
      result: JSON.stringify({ state: 'done', resolution: { status: 'already_resolved', allow: false } }),
    });
    const response = await POST(request({
      sessionId: 'session-1', callId: 'call-1', confirmationId: 'confirm-1', allow: true,
    }));
    expect(await response.json()).toEqual({
      ok: true,
      resolution: { status: 'already_resolved', allow: false },
    });
  });

  it('fails closed on a mismatched session/call/confirmation triple', async () => {
    h.evalJs.mockResolvedValue({ result: JSON.stringify({ state: 'mismatch' }) });
    const response = await POST(request({
      sessionId: 'session-1', callId: 'call-1', confirmationId: 'wrong', allow: true,
    }));
    expect(await response.json()).toEqual({ ok: false, error: 'confirmation_mismatch' });
  });
});
