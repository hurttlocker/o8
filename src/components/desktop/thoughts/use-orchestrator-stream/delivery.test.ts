import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  armOrchestratorSendWatchdog,
  deliveryFailureClientMessageId,
  settleOrchestratorSendWatchdog,
  type PendingOrchestratorSend,
} from './delivery';

function makeHarness() {
  vi.useFakeTimers();
  let messages: MobileTranscriptEntry[] = [];
  const messagesRef: MutableRefObject<MobileTranscriptEntry[]> = { current: messages };
  const pendingRef: MutableRefObject<PendingOrchestratorSend | null> = { current: null };
  const setStatusReady = vi.fn();
  const setMessages: Dispatch<SetStateAction<MobileTranscriptEntry[]>> = vi.fn((update) => {
    messages = typeof update === 'function'
      ? (update as (prev: MobileTranscriptEntry[]) => MobileTranscriptEntry[])(messages)
      : update;
    messagesRef.current = messages;
  });

  armOrchestratorSendWatchdog({
    clientMessageId: 'send-1',
    deliveredAt: 1000,
    originalText: 'ship it',
    pendingRef,
    setStatusReady,
    setMessages,
    messagesRef,
    timeoutMs: 4000,
  });

  return {
    pendingRef,
    setStatusReady,
    get messages() { return messages; },
  };
}

describe('orchestrator delivery watchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ack for the pending clientMessageId clears the timeout', () => {
    const h = makeHarness();

    expect(settleOrchestratorSendWatchdog(h.pendingRef, {
      event: 'send-ack',
      data: { clientMessageId: 'send-1' },
      observedAt: 1100,
    })).toBe(true);
    vi.advanceTimersByTime(5000);

    expect(h.pendingRef.current).toBeNull();
    expect(h.setStatusReady).not.toHaveBeenCalled();
    expect(h.messages).toEqual([]);
  });

  it('any live post-send stream activity clears the timeout', () => {
    const h = makeHarness();

    expect(settleOrchestratorSendWatchdog(h.pendingRef, {
      event: 'status',
      data: { status: 'busy' },
      observedAt: 1001,
    })).toBe(true);
    vi.advanceTimersByTime(5000);

    expect(h.pendingRef.current).toBeNull();
    expect(h.setStatusReady).not.toHaveBeenCalled();
    expect(h.messages).toEqual([]);
  });

  it('timeout appends the retry entry exactly once and preserves the original text', () => {
    const h = makeHarness();

    vi.advanceTimersByTime(4000);
    vi.advanceTimersByTime(4000);

    expect(h.setStatusReady).toHaveBeenCalledTimes(1);
    expect(h.pendingRef.current).toBeNull();
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]?.id).toBe('orch-delivery-error-send-1');
    expect(h.messages[0]?.text).toContain('Message may not have been delivered');
    expect(h.messages[0]?.text).toContain('ship it');
  });

  it('recovers the original clientMessageId from the existing retry entry id', () => {
    expect(deliveryFailureClientMessageId('orch-delivery-error-send-1')).toBe('send-1');
    expect(deliveryFailureClientMessageId('orch-error-send-1')).toBeNull();
  });
});
