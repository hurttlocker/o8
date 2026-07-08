/**
 * Tool-relay correlation + timeout logic (docs/symon-agent-mode.md §"Tool relay
 * semantics"). The relay MUST tolerate parallel calls and correlate strictly by
 * callId; a result for an unknown/resolved callId is dropped, not mis-attributed.
 */
import { describe, expect, it } from 'vitest';

import {
  ToolCallTracker,
  TOOL_TIMEOUT_MS,
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

    const a = t.resolve('a');
    expect(a?.callId).toBe('a');
    expect(t.has('a')).toBe(false);
    expect(t.has('b')).toBe(true);

    const b = t.resolve('b');
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
    expect(t.resolve('ghost')).toBeNull();
    t.add(call('x'));
    expect(t.resolve('x')?.callId).toBe('x');
    expect(t.resolve('x')).toBeNull();
  });

  it('counts in-flight calls per session (drives acting↔live)', () => {
    const t = new ToolCallTracker();
    t.add(call('a', 'sym-1'));
    t.add(call('b', 'sym-1'));
    t.add(call('c', 'sym-2'));
    expect(t.inFlightForSession('sym-1')).toBe(2);
    expect(t.inFlightForSession('sym-2')).toBe(1);
    t.resolve('a');
    expect(t.inFlightForSession('sym-1')).toBe(1);
  });

  it('timedOut removes + returns only calls past the 60s deadline', () => {
    const t = new ToolCallTracker();
    t.add(call('fresh', 'sym-1', 'o8_status', 10_000));
    t.add(call('stale', 'sym-1', 'o8_status', 0));
    const now = TOOL_TIMEOUT_MS + 1; // stale (started at 0) is past; fresh is not
    const timed = t.timedOut(now);
    expect(timed.map((c) => c.callId)).toEqual(['stale']);
    expect(t.has('stale')).toBe(false);
    expect(t.has('fresh')).toBe(true);
  });

  it('removeSession drops every call for a session (stop / preemption)', () => {
    const t = new ToolCallTracker();
    t.add(call('a', 'sym-1'));
    t.add(call('b', 'sym-1'));
    t.add(call('c', 'sym-2'));
    const removed = t.removeSession('sym-1');
    expect(removed.map((c) => c.callId).sort()).toEqual(['a', 'b']);
    expect(t.size()).toBe(1);
    expect(t.has('c')).toBe(true);
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
