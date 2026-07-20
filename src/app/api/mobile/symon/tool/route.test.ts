import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  evalJs: vi.fn<(code: string) => Promise<{ result: string }>>(),
  loadSymonScopeGrant: vi.fn(),
}));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/mcp/o8-webview-client', () => ({
  O8WebviewClient: class {
    evalJs = h.evalJs;
  },
}));
vi.mock('@/lib/mobile/symon-agent-registry', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mobile/symon-agent-registry')>(
    '@/lib/mobile/symon-agent-registry',
  );
  return { ...actual, loadSymonScopeGrant: h.loadSymonScopeGrant };
});

const { POST, buildToolEval } = await import('./route');

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/mobile/symon/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.evalJs.mockReset();
  h.loadSymonScopeGrant.mockReturnValue({
    sessionId: 'session-1',
    subject: 'operator',
    deviceId: null,
    workspaceMode: 'code',
    repoId: 'repo-1',
    repoPath: '/repo',
    allowedTools: ['o8_dispatch'],
    issuedAt: 1,
    scopeVersion: 1,
  });
  delete (globalThis as { __o8BrowserAgentClient?: unknown }).__o8BrowserAgentClient;
});

describe('POST /api/mobile/symon/tool', () => {
  it('passes exact correlation to invokeTool and keys its persistent slot by session + call', () => {
    const code = buildToolEval('session-1', 'call-1', 'o8_dispatch', { repo: '/repo' });
    expect(code).toContain('A.invokeTool("o8_dispatch", {"repo":"/repo"}, { sessionId, callId })');
    expect(code).toContain('JSON.stringify([sessionId, callId])');
    expect(code).toContain('c.sessionId === sessionId && c.callId === callId');
  });

  it('returns the exact pending confirmation without completing the cached invoke', async () => {
    h.evalJs.mockResolvedValue({
      result: JSON.stringify({
        state: 'needs_confirmation',
        confirmation: {
          sessionId: 'session-1',
          callId: 'call-1',
          confirmationId: 'confirm-1',
          taskId: 'realtime-1',
          tool: 'o8_dispatch',
          summary: 'Dispatch o8-mobile',
          expiresAt: 10_000,
          target: { packetId: 'packet-1' },
        },
      }),
    });

    const response = await POST(request({
      sessionId: 'session-1', callId: 'call-1', tool: 'o8_dispatch', args: {},
    }));

    expect(await response.json()).toEqual({
      ok: false,
      result: { error: 'needs_confirmation', detail: 'Approval is required before this action can run.' },
      confirmation: expect.objectContaining({
        sessionId: 'session-1', callId: 'call-1', confirmationId: 'confirm-1',
      }),
    });
  });

  it('fails closed when confirmation correlation does not match the call', async () => {
    h.evalJs.mockResolvedValue({
      result: JSON.stringify({
        state: 'needs_confirmation',
        confirmation: {
          sessionId: 'other', callId: 'call-1', confirmationId: 'confirm-1',
          taskId: 'realtime-1', tool: 'o8_dispatch', summary: 'Dispatch', expiresAt: 10_000, target: {},
        },
      }),
    });
    const response = await POST(request({
      sessionId: 'session-1', callId: 'call-1', tool: 'o8_dispatch', args: {},
    }));
    expect(await response.json()).toEqual({
      ok: false,
      result: { error: 'confirmation_mismatch', detail: 'The desktop returned an uncorrelated confirmation.' },
    });
  });

  it('returns one terminal result from the preserved slot', async () => {
    h.evalJs.mockResolvedValue({ result: JSON.stringify({ state: 'done', ok: true, result: { packet_id: 'p-1' } }) });
    const response = await POST(request({
      sessionId: 'session-1', callId: 'call-1', tool: 'o8_dispatch', args: {},
    }));
    expect(await response.json()).toEqual({ ok: true, result: { packet_id: 'p-1' } });
  });

  it('dry-runs the real immutable scope transform without invoking Rust', async () => {
    const response = await POST(request({
      sessionId: 'session-1',
      callId: 'eval-1',
      tool: 'o8_dispatch',
      args: { task: 'Fix it', repoId: 'repo-1' },
      dryRun: true,
    }));
    expect(await response.json()).toEqual({
      ok: true,
      result: {
        state: 'scoped',
        scopeVersion: 1,
        scopedArgs: {
          task: 'Fix it',
          repoId: 'repo-1',
          repoPath: '/repo',
          repo: '/repo',
        },
      },
    });
    expect(h.evalJs).not.toHaveBeenCalled();
  });

  it('fails closed when the internal route is not bound to the active grant', async () => {
    h.loadSymonScopeGrant.mockReturnValue(null);
    const response = await POST(request({
      sessionId: 'session-1', callId: 'call-1', tool: 'o8_dispatch', args: {},
    }));
    expect(await response.json()).toEqual({
      ok: false,
      result: {
        error: 'session_scope_invalid',
        detail: 'This tool call is not bound to the active Symon session scope.',
      },
    });
    expect(h.evalJs).not.toHaveBeenCalled();
  });
});
