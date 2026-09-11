import { describe, it, expect, vi } from 'vitest';
import type { OrchestratorEvent } from './orchestrator-stream-events';
import {
  claimsDispatch,
  isFalseDispatchTurn,
  runTurnWithFalseDispatchRetry,
  FALSE_DISPATCH_CORRECTION,
  FALSE_DISPATCH_ERROR,
  FALSE_DISPATCH_RETRY_REASON,
  type FalseDispatchAttemptResult,
} from './orchestrator-false-dispatch';

const done = (id: string): Extract<OrchestratorEvent, { type: 'done' }> => (
  { type: 'done', sessionId: id, cost: null }
);

describe('claimsDispatch', () => {
  // Verbatim from the traces on #2142 — these are the turns that must fail.
  it.each([
    'All three are queued in the same wave and the dispatcher is launching them in the background.',
    'Mission: mission-5ff02201-a37. I dispatched three packets; file ownership is disjoint.',
    "I've kicked off the three workers — send me a message when you want me to review.",
    'Agents launched. P1 lands styles.css first.',
    'I fired off agent X against the demo repo.',
  ])('flags a dispatch claim: %s', (text) => {
    expect(claimsDispatch(text)).toBe(true);
  });

  it('does NOT flag the documented false positive (negated claim)', () => {
    // Reported on the issue: the bare-keyword pattern flagged a turn whose text
    // said the OPPOSITE of a dispatch. Under this change that would fail a
    // healthy turn AND feed the model a correction telling it to launch agents
    // it deliberately did not launch.
    const text = 'Nothing dispatched. The three demo-site packets from the previous turn '
      + 'are still out there untouched by this turn.';
    expect(claimsDispatch(text)).toBe(false);
  });

  it.each([
    'I could not dispatch the packets — the volume is under the storage reserve.',
    'I have not launched anything yet; tell me which packets you want.',
    'I will not dispatch until you confirm the file ownership.',
    'Before dispatching agents I want to confirm the branch.',
    'Should I dispatch these three packets?',
    'The retry timer fired and the watchdog reaped the proc.',
    "I'll keep polling the mission status until the workers report.",
  ])('does not flag: %s', (text) => {
    expect(claimsDispatch(text)).toBe(false);
  });

  it('a negation elsewhere does not mask a real claim', () => {
    const text = 'I did not touch styles.css.\nI dispatched three agents against the demo repo.';
    expect(claimsDispatch(text)).toBe(true);
  });
});

describe('isFalseDispatchTurn', () => {
  const claim = 'I dispatched three agents.';

  it('flags a completed, error-free, zero-launch turn that claims a dispatch', () => {
    expect(isFalseDispatchTurn({
      completedResult: true, error: null, launchAgentCallCount: 0, assistantText: claim,
    })).toBe(true);
  });

  it('leaves a turn with at least one launch call completely alone', () => {
    expect(isFalseDispatchTurn({
      completedResult: true, error: null, launchAgentCallCount: 1, assistantText: claim,
    })).toBe(false);
  });

  it('excludes every settle that did not come from a stream result', () => {
    // Watchdog timeout, user abort, stdin-write failure, plan-mode LOCKOUT,
    // crash-tail end, proc close — all settle with completedResult:false.
    expect(isFalseDispatchTurn({
      completedResult: false, error: null, launchAgentCallCount: 0, assistantText: claim,
    })).toBe(false);
  });

  it('excludes a turn that already failed', () => {
    expect(isFalseDispatchTurn({
      completedResult: true, error: new Error('boom'), launchAgentCallCount: 0, assistantText: claim,
    })).toBe(false);
  });
});

/**
 * The defect that killed the previous attempt at this fix: the retry streamed
 * attempt 2's narration into attempt 1's chat bubble, because only the terminal
 * events were ever gated. These assertions are on TEXT events and their content
 * — a suite that only counted `done`/`error` passed while the bug was present.
 */
describe('runTurnWithFalseDispatchRetry', () => {
  function recorder() {
    const events: OrchestratorEvent[] = [];
    return { events, onEvent: (e: OrchestratorEvent) => { events.push(e); } };
  }

  const texts = (events: OrchestratorEvent[]) => events
    .filter((e): e is Extract<OrchestratorEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.text);

  it('a healthy turn runs once and emits nothing extra', async () => {
    const { events, onEvent } = recorder();
    const runAttempt = vi.fn(async (): Promise<FalseDispatchAttemptResult> => {
      onEvent({ type: 'text', text: 'Launched three agents.' });
      onEvent(done('s1'));
      return { falseDispatch: false, withheldDone: null };
    });

    await runTurnWithFalseDispatchRetry({ message: 'fan out', onEvent, runAttempt });

    expect(runAttempt).toHaveBeenCalledTimes(1);
    expect(runAttempt).toHaveBeenCalledWith('fan out', 1);
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    expect(events.some((e) => e.type === 'turn_retry')).toBe(false);
  });

  it('fences the discarded attempt: every text event before the retry belongs to attempt 1, every one after to attempt 2', async () => {
    const { events, onEvent } = recorder();
    const runAttempt = vi.fn(async (message: string, attempt: 1 | 2): Promise<FalseDispatchAttemptResult> => {
      if (attempt === 1) {
        onEvent({ type: 'text', text: 'I dispatched three agents. ' });
        onEvent({ type: 'text', text: 'Send me a message when you want me to review.' });
        return { falseDispatch: true, withheldDone: done('s1') };
      }
      expect(message).toBe(FALSE_DISPATCH_CORRECTION);
      onEvent({ type: 'tool_use', name: 'cortex_launch_agent', input: {} });
      onEvent({ type: 'text', text: 'Launched lane-a, lane-b, lane-c.' });
      onEvent(done('s1'));
      return { falseDispatch: false, withheldDone: null };
    });

    await runTurnWithFalseDispatchRetry({ message: 'fan out', onEvent, runAttempt });

    const boundary = events.findIndex((e) => e.type === 'turn_retry');
    expect(boundary).toBeGreaterThan(-1);
    expect(events.filter((e) => e.type === 'turn_retry')).toHaveLength(1);

    // The discarded attempt's narration is entirely on the far side of the
    // boundary — a consumer that resets on `turn_retry` never shows it next to
    // the retry's reply.
    expect(texts(events.slice(0, boundary))).toEqual([
      'I dispatched three agents. ',
      'Send me a message when you want me to review.',
    ]);
    expect(texts(events.slice(boundary + 1))).toEqual(['Launched lane-a, lane-b, lane-c.']);

    // Attempt 1's withheld `done` is dropped, not replayed — a discarded
    // attempt must not report success.
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('a false dispatch never emits `done` for the discarded attempt', async () => {
    const { events, onEvent } = recorder();
    await runTurnWithFalseDispatchRetry({
      message: 'fan out',
      onEvent,
      runAttempt: async (_m, attempt) => (attempt === 1
        ? { falseDispatch: true, withheldDone: done('s1') }
        : { falseDispatch: false, withheldDone: null }),
    });
    // Attempt 2 in this stub emits no events of its own, so a `done` here could
    // only have come from the discarded attempt.
    expect(events.filter((e) => e.type === 'done')).toHaveLength(0);
  });

  it('carries the retry reason and a human-readable notice on the boundary', async () => {
    const { events, onEvent } = recorder();
    await runTurnWithFalseDispatchRetry({
      message: 'fan out',
      onEvent,
      runAttempt: async (_m, attempt) => (attempt === 1
        ? { falseDispatch: true, withheldDone: done('s1') }
        : { falseDispatch: false, withheldDone: null }),
    });
    const boundary = events.find((e) => e.type === 'turn_retry');
    expect(boundary).toMatchObject({ attempt: 2, reason: FALSE_DISPATCH_RETRY_REASON });
    expect((boundary as Extract<OrchestratorEvent, { type: 'turn_retry' }>).notice).toMatch(/retrying/i);
  });

  it('surfaces an error in the thread when the retry also false-dispatches, and stops at two attempts', async () => {
    const { events, onEvent } = recorder();
    const runAttempt = vi.fn(async (_message: string, attempt: 1 | 2): Promise<FalseDispatchAttemptResult> => {
      onEvent({ type: 'text', text: `attempt ${attempt}: I dispatched three agents.` });
      return { falseDispatch: true, withheldDone: done(`s${attempt}`) };
    });

    await runTurnWithFalseDispatchRetry({ message: 'fan out', onEvent, runAttempt });

    // Bounded and non-recursive.
    expect(runAttempt).toHaveBeenCalledTimes(2);

    const boundary = events.findIndex((e) => e.type === 'turn_retry');
    // Exactly one narration survives on each side of the boundary — the garbled
    // double-narration next to the error banner is what the previous attempt
    // shipped, and it must not reappear.
    expect(texts(events.slice(0, boundary))).toEqual(['attempt 1: I dispatched three agents.']);
    expect(texts(events.slice(boundary + 1))).toEqual(['attempt 2: I dispatched three agents.']);

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect((error as Extract<OrchestratorEvent, { type: 'error' }>).error).toBe(FALSE_DISPATCH_ERROR);

    // `error` then the withheld `done`, mirroring the watchdog path, so the
    // client's "Working M:SS" latch releases.
    const order = events.filter((e) => e.type === 'error' || e.type === 'done').map((e) => e.type);
    expect(order).toEqual(['error', 'done']);
  });
});
