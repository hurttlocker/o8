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

const { DELETE, POST, buildToolEval, buildToolInterruptEval } = await import('./route');

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/mobile/symon/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function interruptRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/mobile/symon/tool', {
    method: 'DELETE',
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
  it('interrupts the exact correlated native task through the persistent webview bridge', async () => {
    const interruptTool = vi.fn().mockResolvedValue(true);
    const windowState = { __o8SymonAgent: { interruptTool } };
    const script = buildToolInterruptEval('session-1', 'call-1');
    const first = Function('window', `return ${script}`)(windowState) as string;
    expect(JSON.parse(first)).toEqual({ state: 'pending' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const second = Function('window', `return ${script}`)(windowState) as string;
    expect(JSON.parse(second)).toEqual({ state: 'done', active: true });
    expect(interruptTool).toHaveBeenCalledWith({ sessionId: 'session-1', callId: 'call-1' });
  });

  it('drops a rejected interrupt cache entry so the next delivery can retry', async () => {
    const interruptTool = vi.fn()
      .mockRejectedValueOnce(new Error('bridge remount'))
      .mockResolvedValueOnce(false);
    const windowState = { __o8SymonAgent: { interruptTool } };
    const script = buildToolInterruptEval('session-1', 'call-1');
    expect(JSON.parse(Function('window', `return ${script}`)(windowState) as string))
      .toEqual({ state: 'pending' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(Function('window', `return ${script}`)(windowState) as string))
      .toMatchObject({ state: 'error' });
    expect(JSON.parse(Function('window', `return ${script}`)(windowState) as string))
      .toEqual({ state: 'pending' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(Function('window', `return ${script}`)(windowState) as string))
      .toEqual({ state: 'done', active: false });
    expect(interruptTool).toHaveBeenCalledTimes(2);
  });

  it('exposes an authenticated DELETE interrupt seam for stop, preemption, and timeout', async () => {
    h.evalJs.mockResolvedValue({ result: JSON.stringify({ state: 'done', active: true }) });
    const response = await DELETE(interruptRequest({ sessionId: 'session-1', callId: 'call-1' }));
    expect(await response.json()).toEqual({ ok: true, delivered: true, wasActive: true });
    expect(h.evalJs.mock.calls[0]?.[0]).toContain('A.interruptTool({ sessionId, callId })');
  });

  it('keeps the exact in-flight plan slot alive across a serial chain longer than five minutes', () => {
    const sessionId = 'session-1';
    const callId = 'plan-call';
    const key = JSON.stringify([sessionId, callId]);
    const invokeTool = vi.fn();
    const slot = {
      startedAt: 1,
      lastTouched: 120_000,
      done: false,
      decisionSubmitted: true,
      tool: 'symon_execute_plan',
    };
    const windowState = {
      __o8SymonAgent: { invokeTool, pendingConfirmations: [] },
      __o8SymonToolCalls: {
        [key]: slot,
        stale: { startedAt: 1, lastTouched: 1 },
      } as Record<string, Record<string, unknown>>,
    };
    const now = vi.spyOn(Date, 'now').mockReturnValue(600_001);
    try {
      const script = buildToolEval(sessionId, callId, 'symon_execute_plan', { steps: [] });
      const raw = Function('window', `return ${script}`)(windowState) as string;
      expect(JSON.parse(raw)).toEqual({ state: 'pending' });
      expect(invokeTool).not.toHaveBeenCalled();
      expect(windowState.__o8SymonToolCalls[key]).toBe(slot);
      expect(slot.lastTouched).toBe(600_001);
      expect(windowState.__o8SymonToolCalls.stale).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  it('expires the current terminal slot after the replay TTL so a reused call id can run', async () => {
    const sessionId = 'session-1';
    const callId = 'reused-call';
    const key = JSON.stringify([sessionId, callId]);
    const invokeTool = vi.fn().mockResolvedValue({ ok: true });
    const windowState = {
      __o8SymonAgent: { invokeTool, pendingConfirmations: [] },
      __o8SymonToolCalls: {
        [key]: {
          startedAt: 1,
          lastTouched: 1,
          completedAt: 1,
          done: true,
          ok: true,
          result: { stale: true },
          tool: 'symon_execute_plan',
        },
      } as Record<string, Record<string, unknown>>,
    };
    const now = vi.spyOn(Date, 'now').mockReturnValue(600_001);
    try {
      const script = buildToolEval(sessionId, callId, 'symon_execute_plan', { steps: [] });
      const raw = Function('window', `return ${script}`)(windowState) as string;
      expect(JSON.parse(raw)).toEqual({ state: 'pending' });
      await Promise.resolve();
      await Promise.resolve();
      expect(invokeTool).toHaveBeenCalledTimes(1);
      expect(windowState.__o8SymonToolCalls[key]?.startedAt).toBe(600_001);
    } finally {
      now.mockRestore();
    }
  });


  it('passes exact correlation to invokeTool and keys its persistent slot by session + call', async () => {
    h.evalJs.mockResolvedValue({
      result: JSON.stringify({ state: 'done', ok: true, result: { accepted: true } }),
    });
    await POST(request({
      sessionId: 'session-1',
      callId: 'call-1',
      tool: 'o8_dispatch',
      args: { task: 'Fix it' },
      utterance: 'Send this to the fleet',
    }));
    const code = h.evalJs.mock.calls[0]?.[0] ?? '';
    expect(code).toContain('A.invokeTool("o8_dispatch", {"task":"Fix it","repoId":"repo-1","repoPath":"/repo","repo":"/repo"}, { sessionId, callId }, "Send this to the fleet")');
    expect(code).toContain('JSON.stringify([sessionId, callId])');
    expect(code).toContain('c.sessionId === sessionId && c.callId === callId');
    expect(code).toContain('hit.confirmationId !== slot.confirmationId');
    expect(code).toContain('slot.decisionSubmitted = false');
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
