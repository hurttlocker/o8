/**
 * Warm-orchestrator lockout — the auto-deny TRIGGER. A resident PLAN-mode proc
 * keeps stdin open, so the "stdin closes ⇒ approval can't be answered" layer is
 * gone; we replace it by KILLing the proc the instant it emits a permission
 * request. This proves the detector fires on every escalation signal and stays
 * quiet on normal read/plan output (so a well-behaved proposer stays warm).
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';

import { attachOrchestratorProcHandlers, detectPermissionRequest, getWarmState } from './orchestrator-session';
import type { OrchestratorSession } from './orchestrator-session';
import { createToolCallTracker } from './orchestrator-stream-events';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockProc(): any {
  const proc = new EventEmitter() as unknown as Record<string, unknown>;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: () => true, destroyed: false, writable: true };
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killed = false;
  proc.kill = vi.fn(() => { proc.killed = true; return true; });
  return proc;
}

function testSession(sessionName: string) {
  return {
    sessionName, repoPath: '/repo', threadId: null, claudeSessionId: null,
    status: 'busy' as const, proc: null, createdAt: Date.now(),
  } as OrchestratorSession;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function testTurn(sink: any[], onResolve: () => void): any {
  return {
    onEvent: (e: unknown) => sink.push(e),
    captureEvent: (e: unknown) => sink.push(e),
    resolve: onResolve,
    reject: () => {},
    timeout: setTimeout(() => {}, 1_000_000),
    abortSignal: null, abortListener: null, settled: false,
    toolTracker: createToolCallTracker(),
    turnSessionId: null, cost: null, lastAssistantText: 'here is my proposal',
    sawToolUseAfterText: false, launchAgentCallCount: 0,
  };
}


describe('detectPermissionRequest — the escalation gate a plan proc must never answer', () => {
  it('flags an explicit permission control event', () => {
    expect(detectPermissionRequest({ type: 'can_use_tool', name: 'Write' })).toBe(true);
    expect(detectPermissionRequest({ type: 'control_request', request: {} })).toBe(true);
    expect(detectPermissionRequest({ type: 'permission_request', name: 'Bash' })).toBe(true);
  });

  it('flags an ExitPlanMode tool call in every shape it can appear', () => {
    // bare
    expect(detectPermissionRequest({ name: 'ExitPlanMode' })).toBe(true);
    expect(detectPermissionRequest({ tool_name: 'exit_plan_mode' })).toBe(true);
    // content_block_start
    expect(detectPermissionRequest({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'ExitPlanMode' } })).toBe(true);
    // assistant message content array
    expect(detectPermissionRequest({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'ExitPlanMode' }] } })).toBe(true);
  });

  it('does NOT flag normal read/plan output — a well-behaved proposer stays warm', () => {
    expect(detectPermissionRequest({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'reading…' } })).toBe(false);
    expect(detectPermissionRequest({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } })).toBe(false);
    expect(detectPermissionRequest({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'Grep' } })).toBe(false);
    expect(detectPermissionRequest({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Glob' }] } })).toBe(false);
    expect(detectPermissionRequest({ type: 'result', session_id: 's', total_cost_usd: 0.01 })).toBe(false);
    expect(detectPermissionRequest({ type: 'system', session_id: 's' })).toBe(false);
  });
});

describe('the lockout predicate — kill only fires on a PLAN-mode proc', () => {
  const isEscalation = (permissionMode: 'plan' | 'full', raw: Record<string, unknown>) =>
    permissionMode === 'plan' && detectPermissionRequest(raw);

  it('a plan proc that asks to escalate is killed; a read is not', () => {
    expect(isEscalation('plan', { type: 'can_use_tool', name: 'Write' })).toBe(true);
    expect(isEscalation('plan', { name: 'ExitPlanMode' })).toBe(true);
    expect(isEscalation('plan', { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } })).toBe(false);
  });

  it('a full-mode proc is never affected (no permission surface — parity)', () => {
    // --dangerously-skip-permissions never emits these, and the guard is plan-only.
    expect(isEscalation('full', { type: 'can_use_tool', name: 'Write' })).toBe(false);
    expect(isEscalation('full', { name: 'ExitPlanMode' })).toBe(false);
  });
});

describe('the lockout FIRES end-to-end on a warm plan proc', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const armPlanProc = (name: string): { session: OrchestratorSession; proc: any; w: any; events: unknown[]; resolved: () => boolean } => {
    const session = testSession(name);
    const proc = mockProc();
    session.proc = proc as unknown as OrchestratorSession['proc'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = getWarmState(name) as any;
    w.procConfig = { cwd: '/repo', model: 'm', permissionMode: 'plan', toolProfile: 'propose', effort: 'adaptive', mcpConfigHash: 'h' };
    const events: unknown[] = [];
    let resolved = false;
    w.activeTurn = testTurn(events, () => { resolved = true; });
    attachOrchestratorProcHandlers(session, w);
    return { session, proc, w, events, resolved: () => resolved };
  };

  it('a proposer emitting ExitPlanMode is KILLED, proc gone, turn settled (write blocked)', () => {
    const { session, proc, events, resolved } = armPlanProc('lockout-plan-1');
    proc.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'ExitPlanMode' } })}\n`));

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM'); // strongest auto-deny
    expect(session.status).toBe('dead');
    expect(session.proc).toBeNull();
    expect(resolved()).toBe(true); // the turn settled (proposal text intact)
    expect(events.some((e) => (e as { type?: string }).type === 'done')).toBe(true);
  });

  it('a can_use_tool control event is also killed', () => {
    const { session, proc } = armPlanProc('lockout-plan-2');
    proc.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'can_use_tool', name: 'Write', id: 'x' })}\n`));
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(session.status).toBe('dead');
  });

  it('PARITY: a full-mode proc settles on `result` and stays WARM (not killed)', () => {
    const session = testSession('warm-full-1');
    const proc = mockProc();
    session.proc = proc as unknown as OrchestratorSession['proc'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = getWarmState('warm-full-1') as any;
    w.procConfig = { cwd: '/repo', model: 'm', permissionMode: 'full', toolProfile: 'full', effort: 'adaptive', mcpConfigHash: 'h' };
    const events: unknown[] = [];
    let resolved = false;
    w.activeTurn = testTurn(events, () => { resolved = true; });
    attachOrchestratorProcHandlers(session, w);

    proc.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', session_id: 'sid', total_cost_usd: 0.02 })}\n`));

    expect(proc.kill).not.toHaveBeenCalled(); // no kill on a normal turn end
    expect(resolved).toBe(true);              // settled on `result`
    expect(session.proc).not.toBeNull();      // proc stays RESIDENT for the next turn
    expect(session.status).toBe('ready');
  });
});

describe('recycle race — a replaced proc\'s late events must not touch the new turn', () => {
  // Live-hit 2026-07-13: a config-change recycle SIGTERM'd the old proc, the
  // new proc spawned and the turn started — then the OLD proc's `close` fired
  // on the event loop, settled the NEW turn as "proc exited with code 143" and
  // clobbered session.proc. Every recycle-triggering turn died instantly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const armRecycledPair = (name: string): { session: OrchestratorSession; oldProc: any; newProc: any; w: any; events: unknown[]; resolved: () => boolean } => {
    const session = testSession(name);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = getWarmState(name) as any;
    const oldProc = mockProc();
    session.proc = oldProc as unknown as OrchestratorSession['proc'];
    attachOrchestratorProcHandlers(session, w);
    // Recycle: killOrchestratorProc nulls the ref, then a new proc spawns and
    // the next turn arms against it.
    session.proc = null;
    const newProc = mockProc();
    session.proc = newProc as unknown as OrchestratorSession['proc'];
    w.procConfig = { cwd: '/repo', model: 'm', permissionMode: 'full', toolProfile: 'full', effort: 'adaptive', mcpConfigHash: 'h2' };
    attachOrchestratorProcHandlers(session, w);
    const events: unknown[] = [];
    let resolved = false;
    w.activeTurn = testTurn(events, () => { resolved = true; });
    session.status = 'busy';
    return { session, oldProc, newProc, w, events, resolved: () => resolved };
  };

  it('the OLD proc\'s late close (SIGTERM 143) leaves the new turn and proc untouched', () => {
    const { session, oldProc, newProc, w, events, resolved } = armRecycledPair('recycle-race-1');

    oldProc.emit('close', 143);

    expect(resolved()).toBe(false);                 // new turn NOT settled by the stale close
    expect(w.activeTurn?.settled).toBe(false);
    expect(session.proc).toBe(newProc);             // proc reference NOT clobbered
    expect(session.status).toBe('busy');            // turn still live
    expect(events.some((e) => (e as { type?: string }).type === 'error')).toBe(false);
  });

  it('stale stdout from the OLD proc never reaches the new turn\'s line handler', () => {
    const { oldProc, w, events } = armRecycledPair('recycle-race-2');

    oldProc.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', session_id: 'stale' })}\n`));

    expect(w.activeTurn?.settled).toBe(false);      // stale `result` cannot settle the new turn
    expect(events.length).toBe(0);
  });

  it('the CURRENT proc crashing mid-turn still settles the turn (crash path intact)', () => {
    const { session, newProc, w, resolved } = armRecycledPair('recycle-race-3');

    newProc.emit('close', 1);

    expect(resolved()).toBe(true);                  // genuine crash still settles
    expect(w.activeTurn).toBeNull();
    expect(session.proc).toBeNull();
    expect(session.status).toBe('dead');
  });
});
