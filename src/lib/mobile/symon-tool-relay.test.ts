/**
 * Tool-relay correlation + timeout logic (docs/symon-agent-mode.md §"Tool relay
 * semantics"). The relay MUST tolerate parallel calls and correlate strictly by
 * sessionId + callId; unknown results are dropped, not mis-attributed.
 */
import { describe, expect, it } from 'vitest';

import {
  ToolCallTracker,
  SymonAsyncActionTracker,
  SymonConfirmationTracker,
  TOOL_TIMEOUT_MS,
  buildSymonActionComplete,
  toolTimeoutResult,
  toolErrorResult,
  deriveOk,
} from './symon-tool-relay';

function call(callId: string, sessionId = 'sym-1', tool = 'o8_status', startedAt = 0) {
  return { sessionId, callId, tool, startedAt };
}

describe('ToolCallTracker — strict callId correlation', () => {
  it('correlates concurrent calls independently by callId', () => {
    const t = new ToolCallTracker();
    expect(t.add(call('a'))).toBe(true);
    expect(t.add(call('b'))).toBe(true);
    expect(t.size()).toBe(2);

    const a = t.resolve('sym-1', 'a');
    expect(a?.callId).toBe('a');
    expect(t.has('sym-1', 'a')).toBe(false);
    expect(t.has('sym-1', 'b')).toBe(true);

    const b = t.resolve('sym-1', 'b');
    expect(b?.callId).toBe('b');
    expect(t.size()).toBe(0);
  });

  it('rejects a duplicate callId already in flight', () => {
    const t = new ToolCallTracker();
    expect(t.add(call('dup'))).toBe(true);
    expect(t.add(call('dup'))).toBe(false);
    expect(t.size()).toBe(1);
  });

  it('resolving an unknown/already-resolved callId returns null (dropped, not guessed)', () => {
    const t = new ToolCallTracker();
    expect(t.resolve('sym-1', 'ghost')).toBeNull();
    t.add(call('x'));
    expect(t.resolve('sym-1', 'x')?.callId).toBe('x');
    expect(t.resolve('sym-1', 'x')).toBeNull();
  });

  it('counts in-flight calls per session (drives acting↔live)', () => {
    const t = new ToolCallTracker();
    t.add(call('a', 'sym-1'));
    t.add(call('b', 'sym-1'));
    t.add(call('c', 'sym-2'));
    expect(t.inFlightForSession('sym-1')).toBe(2);
    expect(t.inFlightForSession('sym-2')).toBe(1);
    t.resolve('sym-1', 'a');
    expect(t.inFlightForSession('sym-1')).toBe(1);
  });

  it('timedOut returns only calls past the deadline for terminal caching', () => {
    const t = new ToolCallTracker();
    t.add(call('fresh', 'sym-1', 'o8_status', 10_000));
    t.add(call('stale', 'sym-1', 'o8_status', 0));
    const now = TOOL_TIMEOUT_MS + 1; // stale (started at 0) is past; fresh is not
    const timed = t.timedOut(now);
    expect(timed.map((c) => c.callId)).toEqual(['stale']);
    expect(t.has('sym-1', 'stale')).toBe(true);
    expect(t.has('sym-1', 'fresh')).toBe(true);
    t.complete('sym-1', 'stale', toolTimeoutResult(), now);
    expect(t.has('sym-1', 'stale')).toBe(false);
    expect(t.replay('sym-1', 'stale', now)?.outcome).toEqual(toolTimeoutResult());
  });

  it('removeSession drops every call for a session (stop / preemption)', () => {
    const t = new ToolCallTracker();
    t.add(call('a', 'sym-1'));
    t.add(call('b', 'sym-1'));
    t.add(call('c', 'sym-2'));
    const removed = t.removeSession('sym-1');
    expect(removed.map((c) => c.callId).sort()).toEqual(['a', 'b']);
    expect(t.size()).toBe(1);
    expect(t.has('sym-2', 'c')).toBe(true);
  });

  it('keys calls by sessionId + callId and replays one terminal result', () => {
    const t = new ToolCallTracker();
    expect(t.add(call('same', 'sym-1'))).toBe(true);
    expect(t.add(call('same', 'sym-2'))).toBe(true);
    const complete = t.complete('sym-1', 'same', { ok: true, result: { value: 1 } }, 10);
    expect(complete?.action.status).toBe('done');
    expect(t.replay('sym-1', 'same', 11)?.outcome).toEqual({ ok: true, result: { value: 1 } });
    expect(t.add(call('same', 'sym-1', 'o8_status', 12))).toBe(false);
    expect(t.has('sym-2', 'same')).toBe(true);
  });

  it('pauses execution timeout while awaiting confirmation', () => {
    const t = new ToolCallTracker();
    t.add(call('confirm'));
    t.markAwaitingConfirmation('sym-1', 'confirm', 'confirmation-1');
    expect(t.timedOut(TOOL_TIMEOUT_MS + 1)).toEqual([]);
    t.markExecuting('sym-1', 'confirm', TOOL_TIMEOUT_MS + 1);
    expect(t.timedOut((TOOL_TIMEOUT_MS * 2) + 2).map((item) => item.callId)).toEqual(['confirm']);
  });

  it('preemption tombstones active calls so a retry cannot execute twice', () => {
    const t = new ToolCallTracker();
    t.add(call('preempted'));
    expect(t.abortSession('sym-1', 'session_preempted', 10)[0]?.action.status).toBe('stopped');
    expect(t.replay('sym-1', 'preempted', 11)?.outcome).toEqual({
      ok: false,
      result: { error: 'session_preempted' },
    });
    expect(t.add(call('preempted', 'sym-1', 'o8_status', 12))).toBe(false);
  });
});

describe('tool-relay result shapes', () => {
  it('toolTimeoutResult is the contract shape', () => {
    expect(toolTimeoutResult()).toEqual({ ok: false, result: { error: 'tool_timeout' } });
  });

  it('toolErrorResult carries code (+ optional detail)', () => {
    expect(toolErrorResult('needs_confirmation', 'Approve on the Mac dock')).toEqual({
      ok: false,
      result: { error: 'needs_confirmation', detail: 'Approve on the Mac dock' },
    });
    expect(toolErrorResult('bad_request')).toEqual({ ok: false, result: { error: 'bad_request' } });
  });

  it('deriveOk mirrors the desk client — an error-carrying value is a failure', () => {
    expect(deriveOk({ error: 'nope' })).toBe(false);
    expect(deriveOk({ ok: true, data: 1 })).toBe(true);
    expect(deriveOk('a string result')).toBe(true);
    expect(deriveOk(null)).toBe(true);
    expect(deriveOk({ value: 42 })).toBe(true);
  });
});

describe('SymonConfirmationTracker', () => {
  function confirmation(expiresAt = 1_000) {
    return {
      sessionId: 'sym-1',
      callId: 'call-1',
      confirmationId: 'confirm-1',
      taskId: 'realtime-1',
      tool: 'o8_dispatch',
      summary: 'Dispatch o8-mobile',
      expiresAt,
      target: { packetId: 'pkt-1' },
    };
  }

  it('enforces the exact triple and first decision wins', () => {
    const t = new SymonConfirmationTracker();
    expect(t.register(confirmation(), 0)).toBe(true);
    expect(t.claim({
      sessionId: 'sym-1', callId: 'wrong', confirmationId: 'confirm-1',
      allow: true, clientMutationId: 'm-0', now: 1,
    })).toEqual({ kind: 'missing' });
    expect(t.claim({
      sessionId: 'sym-1', callId: 'call-1', confirmationId: 'confirm-1',
      allow: true, clientMutationId: 'm-1', now: 1,
    })).toMatchObject({ kind: 'claimed', allow: true });
    expect(t.claim({
      sessionId: 'sym-1', callId: 'call-1', confirmationId: 'confirm-1',
      allow: false, clientMutationId: 'm-2', now: 2,
    })).toMatchObject({ kind: 'in_flight' });
    t.settle('sym-1', 'call-1', 'confirm-1', 'approved', 3);
    expect(t.claim({
      sessionId: 'sym-1', callId: 'call-1', confirmationId: 'confirm-1',
      allow: false, clientMutationId: 'm-3', now: 4,
    })).toMatchObject({ kind: 'replay', outcome: 'approved' });
  });

  it('forces late decisions and session preemption to deny', () => {
    const expired = new SymonConfirmationTracker();
    expired.register(confirmation(10), 0);
    expect(expired.claim({
      sessionId: 'sym-1', callId: 'call-1', confirmationId: 'confirm-1',
      allow: true, clientMutationId: 'm-1', now: 10,
    })).toMatchObject({ kind: 'claimed', allow: false, forcedOutcome: 'expired' });

    const preempted = new SymonConfirmationTracker();
    preempted.register(confirmation(100), 0);
    expect(preempted.preemptSession('sym-1')).toEqual([confirmation(100)]);
    expect(preempted.claim({
      sessionId: 'sym-1', callId: 'call-1', confirmationId: 'confirm-1',
      allow: true, clientMutationId: 'm-2', now: 1,
    })).toMatchObject({ kind: 'in_flight' });
  });
});

describe('buildSymonActionComplete', () => {
  it('normalizes stable ids and maps review/accepted/stopped states', () => {
    expect(buildSymonActionComplete(
      call('dispatch', 'sym-1', 'o8_dispatch'),
      { ok: true, result: { approval_id: 'approval-1', packet_id: 'packet-1' } },
      0,
    )).toMatchObject({ status: 'review', approvalId: 'approval-1', packetId: 'packet-1' });
    expect(buildSymonActionComplete(
      call('delegate', 'sym-1', 'o8_delegate'),
      { ok: true, result: { task_id: 'task-1' } },
      0,
    )).toMatchObject({ status: 'accepted', taskId: 'task-1' });
    expect(buildSymonActionComplete(
      call('declined', 'sym-1', 'o8_dispatch'),
      { ok: false, result: { error: 'User declined', declined_by_user: true } },
      0,
    )).toMatchObject({ status: 'stopped' });
  });
});

describe('SymonAsyncActionTracker', () => {
  const accepted = (overrides: Partial<ReturnType<typeof buildSymonActionComplete>> = {}) => ({
    sessionId: 'sym-1',
    callId: 'call-1',
    tool: 'o8_dispatch',
    status: 'accepted' as const,
    packetId: 'pkt-1',
    laneId: 'lane-1',
    ts: new Date(0).toISOString(),
    ...overrides,
  });

  it('turns a dispatch acceptance into one correlated review completion', () => {
    const tracker = new SymonAsyncActionTracker();
    expect(tracker.register(accepted(), '/repo', 0)).toBe(true);
    expect(tracker.settleLane({
      laneId: 'other', packetId: 'pkt-other', repoPath: '/repo', status: 'reviewing',
    }, 1)).toEqual([]);
    expect(tracker.settleLane({
      laneId: 'lane-1', packetId: 'pkt-1', repoPath: '/repo', status: 'reviewing',
    }, 2)).toEqual([expect.objectContaining({
      sessionId: 'sym-1', callId: 'call-1', status: 'review', laneId: 'lane-1',
    })]);
    expect(tracker.size()).toBe(0);
  });

  it('maps completed and failed lane states and removes stopped sessions', () => {
    const tracker = new SymonAsyncActionTracker();
    tracker.register(accepted({ callId: 'done' }), '/repo', 0);
    expect(tracker.settleLane({
      laneId: 'lane-1', packetId: 'pkt-1', repoPath: '/repo', status: 'completed',
    }, 2)[0]?.status).toBe('done');

    tracker.register(accepted({ callId: 'failed' }), '/repo', 3);
    expect(tracker.settleLane({
      laneId: 'lane-1', packetId: 'pkt-1', repoPath: '/repo', status: 'failed',
    }, 4)[0]?.status).toBe('failed');

    tracker.register(accepted({ callId: 'removed', sessionId: 'sym-2' }), '/repo', 5);
    tracker.removeSession('sym-2');
    expect(tracker.size()).toBe(0);
  });
});
