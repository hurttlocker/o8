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
  isPendingStale,
} from '@/lib/mobile/pending-queue';
import { discardRippleDraft, rippleDraftForQueue, restoreQueuedRippleDraft } from '@/lib/mobile/ripple-client';

export function wrapWithOfflineQueue(base: ChatModelAdapter, tabId: string, repoPath: string | null = null): ChatModelAdapter {
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
          const draftId = options.runConfig?.custom?.rippleDraftId;
          const ripple = rippleDraftForQueue(draftId, tabId, repoPath, lastUserText);
          if (draftId && !ripple) {
            yield {
              content: [{ type: 'text', text: 'This intent confirmation expired. Reconnect and confirm the choice again before sending.' }],
              status: { type: 'incomplete', reason: 'error' },
            };
            return;
          }
          const stored = enqueuePending('assistant', tabId, lastUserText, undefined, ripple ?? undefined);
          if (!stored) {
            yield {
              content: [{ type: 'text', text: `Queue full (${PENDING_QUEUE_MAX} pending). Retry once you have signal.` }],
              status: { type: 'complete', reason: 'stop' },
            };
            return;
          }
          if (ripple?.scope) discardRippleDraft(ripple.scope.draftId);
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

export function useDrainAssistantQueueOnline(tabId: string | null, repoPath: string | null = null) {
  const assistantRuntime = useAssistantRuntime();
  useEffect(() => {
    if (typeof window === 'undefined' || !tabId) return;
    const drain = () => {
      const pending = getPendingQueue('assistant', tabId);
      if (pending.length === 0) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      for (const item of pending) {
        if ('ripple' in item && isPendingStale(item)) continue;
        const ripple = 'ripple' in item ? restoreQueuedRippleDraft(item.ripple, tabId, repoPath, item.text) : null;
        // Keep invalid, stale, or out-of-scope confirmations queued. Never
        // dispatch their original ambiguous words without the chosen field.
        if ('ripple' in item && !ripple) continue;
        try {
          assistantRuntime.thread.append(ripple ? {
            role: 'user', content: [{ type: 'text', text: ripple.utterance }],
            runConfig: { custom: { rippleDraftId: ripple.draftId } },
          } : item.text);
        } catch {
          return;
        }
        removePending('assistant', tabId, item.id);
      }
    };
    window.addEventListener('online', drain);
    drain();
    return () => window.removeEventListener('online', drain);
  }, [assistantRuntime, tabId, repoPath]);
}
