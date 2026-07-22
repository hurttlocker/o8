import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveApproval } from '@/lib/approvals/resolution';
import { getApproval, listApprovals } from '@/lib/approvals/store';
import {
  buildPiPermissionDefaultResponse,
  handlePiPermissionRequest,
  splitPiRpcJsonlFrames,
} from './owned';

afterEach(() => {
  vi.useRealTimers();
});

describe('Pi RPC framing', () => {
  it('splits only on LF and preserves U+2028 inside JSON strings', () => {
    const payload = Buffer.from('{"type":"message_update","text":"a b"}\n{"type":"agent_end"}\n', 'utf8');
    const result = splitPiRpcJsonlFrames(payload);
    expect(result.carry).toBe('');
    expect(result.lines).toHaveLength(2);
    expect(JSON.parse(result.lines[0])).toEqual({
      type: 'message_update',
      text: 'a b',
    });
  });

  it('carries partial frames across chunks', () => {
    const first = splitPiRpcJsonlFrames(Buffer.from('{"type":"agent_', 'utf8'));
    expect(first.lines).toEqual([]);
    const second = splitPiRpcJsonlFrames(Buffer.from('end"}\n', 'utf8'), first.carry);
    expect(second.lines).toEqual(['{"type":"agent_end"}']);
    expect(second.carry).toBe('');
  });
});

describe('Pi permission gate safe defaults', () => {
  it('denies confirm requests', () => {
    expect(buildPiPermissionDefaultResponse({
      type: 'extension_ui_request',
      id: 'req-1',
      kind: 'confirm',
    })).toMatchObject({
      type: 'extension_ui_response',
      id: 'req-1',
      requestId: 'req-1',
      value: false,
      confirmed: false,
    });
  });

  it('cancels select/input requests', () => {
    expect(buildPiPermissionDefaultResponse({
      type: 'extension_ui_request',
      requestId: 'req-2',
      kind: 'select',
    })).toMatchObject({
      type: 'extension_ui_response',
      id: 'req-2',
      requestId: 'req-2',
      cancelled: true,
      value: null,
    });
  });
});

describe('Pi permission-gate bridge', () => {
  function fakeSession(sessionKey: string) {
    return {
      surfaceId: sessionKey,
      title: 'Pi Test Session',
      repoPath: process.cwd(),
      branch: 'test-branch',
    };
  }

  it('creates a real approval and sends an accepted extension_ui_response after operator approval', async () => {
    const sessionKey = `pi-owned:test-approve-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sent: Array<Record<string, unknown>> = [];
    const frame = {
      type: 'extension_ui_request',
      id: 'req-approve',
      kind: 'confirm',
      title: 'Allow Pi to run a shell command?',
      toolName: 'shell',
    };

    const pending = handlePiPermissionRequest(frame, fakeSession(sessionKey), {
      send(command) {
        sent.push(command);
        return true;
      },
    }, { timeoutMs: 2_000, pollMs: 10 });

    const approval = listApprovals({ status: 'pending', sessionKey, projectId: null })[0];
    expect(approval).toBeTruthy();
    expect(approval.runtime).toBe('pi');
    expect(approval.source).toBe('runtime');
    expect(approval.args?.requestId).toBe('req-approve');

    resolveApproval(approval.id, 'approve', 'desktop');
    await pending;

    expect(sent).toEqual([expect.objectContaining({
      type: 'extension_ui_response',
      id: 'req-approve',
      requestId: 'req-approve',
      value: true,
      confirmed: true,
    })]);
  });

  it('times out pending confirm requests with denial and expires the approval card', async () => {
    vi.useFakeTimers();
    const sessionKey = `pi-owned:test-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sent: Array<Record<string, unknown>> = [];
    const frame = {
      type: 'extension_ui_request',
      id: 'req-timeout',
      kind: 'confirm',
      title: 'Allow Pi timeout test?',
    };

    const pending = handlePiPermissionRequest(frame, fakeSession(sessionKey), {
      send(command) {
        sent.push(command);
        return true;
      },
    }, { timeoutMs: 50, pollMs: 10 });

    const approval = listApprovals({ status: 'pending', sessionKey, projectId: null })[0];
    expect(approval).toBeTruthy();

    await vi.advanceTimersByTimeAsync(60);
    await pending;

    expect(sent).toEqual([expect.objectContaining({
      type: 'extension_ui_response',
      id: 'req-timeout',
      requestId: 'req-timeout',
      value: false,
      confirmed: false,
      reason: expect.stringContaining('timed out'),
    })]);
    expect(getApproval(approval.id)?.status).toBe('rejected');
    expect(getApproval(approval.id)?.resolution?.note).toContain('timed out');
  });
});
