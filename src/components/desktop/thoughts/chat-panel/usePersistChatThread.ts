import { useCallback, useRef } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

const DEBOUNCE_MS = 800;

function serializeMessages(msgs: MobileTranscriptEntry[]) {
  return msgs.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.text,
    type: m.type,
    media: m.media,
    toolCalls: m.toolCalls,
    timestamp: m.timestamp ?? Date.now(),
    timestampLabel: m.timestampLabel,
    model: m.model,
    tokens: m.tokens,
    costUsd: m.costUsd,
    sources: m.sources,
    thinking: m.thinking,
    thinkingSteps: m.thinkingSteps,
    thinkingDurationMs: m.thinkingDurationMs,
    recalledFacts: m.recalledFacts,
    command: m.command,
    compaction: m.compaction,
  }));
}

export function usePersistChatThread(resolvedRepoPath: string | null) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPending = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const persistThreadNow = useCallback(
    async (
      msgs: MobileTranscriptEntry[],
      tid: string | null,
      nextPlanText: string | null,
      options?: { title?: string | null },
    ) => {
      if (!tid) return;
      try {
        await fetch('/api/v2/chat-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tabId: tid,
            messages: serializeMessages(msgs),
            model: 'claude-code',
            planText: nextPlanText ?? undefined,
            repoPath: resolvedRepoPath,
            title: options?.title ?? undefined,
          }),
        });
      } catch {
        // silent
      }
    },
    [resolvedRepoPath],
  );

  const persistThread = useCallback(
    (msgs: MobileTranscriptEntry[], tid: string | null, nextPlanText: string | null) => {
      if (!tid) return;
      cancelPending();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void persistThreadNow(msgs, tid, nextPlanText);
      }, DEBOUNCE_MS);
    },
    [cancelPending, persistThreadNow],
  );

  return { persistThread, persistThreadNow, cancelPendingPersist: cancelPending };
}
