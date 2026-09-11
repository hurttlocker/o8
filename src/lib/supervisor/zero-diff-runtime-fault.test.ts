import { describe, expect, it } from 'vitest';

import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';
import {
  classifyZeroDiffTranscript,
  planZeroDiffRuntimeRetry,
  ZERO_DIFF_RUNTIME_RETRY_CAP,
} from './zero-diff-runtime-fault';

function assistant(text: string): TranscriptEvent {
  return { seq: 1, ts: '2026-09-11T00:00:00.000Z', type: 'assistant', text };
}

describe('classifyZeroDiffTranscript', () => {
  it('reads an error event as a runtime failure and keeps its message', () => {
    const classification = classifyZeroDiffTranscript({
      events: [
        assistant('Planning the change.'),
        { seq: 2, ts: '2026-09-11T00:00:01.000Z', type: 'error', message: 'opencode run error' },
      ],
    });

    expect(classification.cause).toBe('runtime_error');
    expect(classification.detail).toBe('opencode run error');
  });

  it('reads a non-zero terminal exit as a runtime failure', () => {
    const classification = classifyZeroDiffTranscript({
      events: [
        assistant('Working.'),
        { seq: 2, ts: '2026-09-11T00:00:01.000Z', type: 'done', exitCode: 1 },
      ],
    });

    expect(classification.cause).toBe('runtime_error');
    expect(classification.detail).toContain('code 1');
  });

  it('reads a clean terminal exit as a deliberate no-op, never a fault', () => {
    const classification = classifyZeroDiffTranscript({
      events: [
        assistant('Everything already satisfies the request; nothing to change.'),
        { seq: 2, ts: '2026-09-11T00:00:01.000Z', type: 'done', exitCode: 0 },
      ],
    });

    expect(classification.cause).toBe('clean_no_op');
  });

  it('will not call a run clean when the runtime has no transcript support', () => {
    const classification = classifyZeroDiffTranscript({
      events: [],
      unsupportedReason: 'gemini-transcript-not-supported-yet',
    });

    expect(classification.cause).toBe('indeterminate');
    expect(classification.detail).toContain('gemini-transcript-not-supported-yet');
  });

  it('will not call a run clean when the transcript is empty', () => {
    expect(classifyZeroDiffTranscript({ events: [] }).cause).toBe('indeterminate');
  });

  it('will not call a run clean when it stopped without a terminal event', () => {
    const classification = classifyZeroDiffTranscript({ events: [assistant('Thinking...')] });

    expect(classification.cause).toBe('indeterminate');
  });
});

describe('planZeroDiffRuntimeRetry', () => {
  it('authorizes the first retry on a fresh packet', () => {
    expect(planZeroDiffRuntimeRetry(undefined)).toMatchObject({
      retry: true,
      retriesSpent: 0,
      retryNumber: 1,
      cap: ZERO_DIFF_RUNTIME_RETRY_CAP,
    });
  });

  it('refuses once the budget is spent, so the loop is bounded', () => {
    expect(planZeroDiffRuntimeRetry(ZERO_DIFF_RUNTIME_RETRY_CAP).retry).toBe(false);
    expect(planZeroDiffRuntimeRetry(ZERO_DIFF_RUNTIME_RETRY_CAP + 5).retry).toBe(false);
  });

  it('treats a corrupt counter as unspent rather than as infinite budget', () => {
    expect(planZeroDiffRuntimeRetry(Number.NaN).retriesSpent).toBe(0);
    expect(planZeroDiffRuntimeRetry(-3).retriesSpent).toBe(0);
  });
});
