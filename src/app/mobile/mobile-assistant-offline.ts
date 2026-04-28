'use client';

/**
 * Assistant chat offline queue glue (packet #646).
 *
 * Two pieces:
 *   1. `wrapWithOfflineQueue` — wraps a `ChatModelAdapter` so that when
 *      navigator.onLine is false at run time, the last user message text is
 *      persisted to the assistant pending queue and a "Queued — will retry"
 *      assistant turn is yielded immediately. The user message itself is
 *      already in AUI's thread state by the time run() is invoked, so we
 *      don't need to mirror it.
 *   2. `useDrainAssistantQueueOnline` — listens for browser `online` events
 *      and re-appends each queued user text via the AUI thread runtime,
 *      removing items from storage as they commit. The original "Queued..."
 *      assistant turn stays in transcript as the historical receipt.
 *
 * Kept in its own module so `mobile-assistant-chat-thread.tsx` stays inside
 * its packet diff budget.
 */

import { useEffect } from 'react';
import { useAssistantRuntime, type ChatModelAdapter } from '@assistant-ui/react';
import {
  enqueuePending,
  getPendingQueue,
  removePending,
  PENDING_QUEUE_MAX,
} from '@/lib/mobile/pending-queue';

export function wrapWithOfflineQueue(base: ChatModelAdapter, tabId: string): ChatModelAdapter {
  return {
    run: async function* (options) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        let lastUserText = '';
        for (let i = options.messages.length - 1; i >= 0; i -= 1) {
          const message = options.messages[i];
          if (message.role !== 'user') continue;
          for (const part of message.content ?? []) {
            if (part.type === 'text' && typeof part.text === 'string') {
              lastUserText = part.text;
              break;
            }
          }
          if (lastUserText) break;
        }
        if (lastUserText && tabId) {
          const stored = enqueuePending('assistant', tabId, lastUserText);
          if (!stored) {
            yield {
              content: [{ type: 'text', text: `Queue full (${PENDING_QUEUE_MAX} pending). Retry once you have signal.` }],
              status: { type: 'complete', reason: 'stop' },
            };
            return;
          }
        }
        yield {
          content: [{ type: 'text', text: 'Queued — will retry when you are back online.' }],
          status: { type: 'complete', reason: 'stop' },
        };
        return;
      }
      const result = base.run(options);
      if (result && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
        for await (const chunk of result as AsyncIterable<Awaited<typeof result>>) {
          yield chunk as never;
        }
        return;
      }
      const awaited = await (result as Promise<unknown>);
      yield awaited as never;
    },
  };
}

export function useDrainAssistantQueueOnline(tabId: string | null) {
  const assistantRuntime = useAssistantRuntime();
  useEffect(() => {
    if (typeof window === 'undefined' || !tabId) return;
    const drain = () => {
      const pending = getPendingQueue('assistant', tabId);
      if (pending.length === 0) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      for (const item of pending) {
        try {
          assistantRuntime.thread.append(item.text);
        } catch {
          return;
        }
        removePending('assistant', tabId, item.id);
      }
    };
    window.addEventListener('online', drain);
    drain();
    return () => window.removeEventListener('online', drain);
  }, [assistantRuntime, tabId]);
}
