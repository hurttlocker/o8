import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';
import {
  armOrchestratorSendWatchdog,
  settleOrchestratorSendWatchdog,
  type PendingOrchestratorSend,
} from './delivery';
import {
  listPersistedOrchestratorPendingSends,
  persistOrchestratorPendingSend,
  settlePersistedOrchestratorPendingSend,
  type PendingSendStorage,
  type PersistedOrchestratorPendingSend,
} from './pending-send-store';
import { pendingSendWirePayload } from './durable-pending-send';

function memoryStorage(): PendingSendStorage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

const pending: PersistedOrchestratorPendingSend = {
  text: 'ship it',
  displayMessage: 'ship it',
  threadId: 'thoughts-1',
  clientMessageId: 'send-1',
  sentAtMs: 1000,
};

describe('orchestrator pending-send store', () => {
  afterEach(() => vi.useRealTimers());

  it('write then ack settlement removes the pending send', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    persistOrchestratorPendingSend(pending, storage);
    const pendingRef: MutableRefObject<PendingOrchestratorSend | null> = { current: null };
    armOrchestratorSendWatchdog({
      clientMessageId: pending.clientMessageId,
      deliveredAt: pending.sentAtMs,
      originalText: pending.displayMessage,
      pendingRef,
      setStatusReady: vi.fn(),
      setMessages: vi.fn(),
      messagesRef: { current: [] },
      onSettled: () => settlePersistedOrchestratorPendingSend(
        pending.threadId,
        pending.clientMessageId,
        storage,
      ),
    });

    settleOrchestratorSendWatchdog(pendingRef, {
      event: 'send-ack',
      data: { clientMessageId: pending.clientMessageId, state: 'accepted' },
      observedAt: 1100,
    });

    expect(listPersistedOrchestratorPendingSends(pending.threadId, storage, 1100)).toEqual([]);
  });

  it('write then remount lists the pending send for its thread', () => {
    const storage = memoryStorage();
    persistOrchestratorPendingSend(pending, storage);

    expect(listPersistedOrchestratorPendingSends(pending.threadId, storage, 1100)).toEqual([pending]);
    expect(listPersistedOrchestratorPendingSends('thoughts-other', storage, 1100)).toEqual([]);
  });

  it('does not reconstruct an image send as text after storage quota fallback', () => {
    const storage = memoryStorage();
    const originalSetItem = storage.setItem;
    storage.setItem = (key, value) => {
      if (value.includes('wirePayload')) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      originalSetItem(key, value);
    };
    const imagePending = {
      ...pending,
      attachmentsRequired: true,
      wirePayload: JSON.stringify({ type: 'orchestrator-send', attachments: [{ dataUri: 'data:image/png;base64,aW1hZ2U=' }] }),
    };
    persistOrchestratorPendingSend(imagePending, storage);

    const [restored] = listPersistedOrchestratorPendingSends(pending.threadId, storage, 1100);
    expect(restored.attachmentsRequired).toBe(true);
    expect(restored).not.toHaveProperty('wirePayload');
    expect(pendingSendWirePayload(restored, '/repo')).toBeNull();
    expect(pendingSendWirePayload(imagePending, '/repo')).toBe(imagePending.wirePayload);
  });
});
