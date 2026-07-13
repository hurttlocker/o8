import { useCallback, useRef } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { serializeTranscriptForStorage } from '@/lib/transcripts/history-serde';

const DEBOUNCE_MS = 800;

function serializeMessages(msgs: MobileTranscriptEntry[]) {
  return serializeTranscriptForStorage(msgs);
}

export function usePersistChatThread(resolvedRepoPath: string | null) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titlePokeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPending = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // The server-side auto-titler names the thread a few seconds after a
  // persist lands (free-model call, fire-and-forget). Poke the title-sync
  // listeners once after that window so the header pill + left rail pick
  // up the generated name without a thread switch. Single timer — a newer
  // persist supersedes the pending poke.
  const scheduleTitlePoke = useCallback((threadId: string) => {
    if (typeof window === 'undefined') return;
    if (titlePokeRef.current) clearTimeout(titlePokeRef.current);
    titlePokeRef.current = setTimeout(() => {
      titlePokeRef.current = null;
      window.dispatchEvent(new CustomEvent('o8:thread-title-maybe-updated', { detail: { threadId } }));
    }, 6000);
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
        if (msgs.length >= 2) scheduleTitlePoke(tid);
      } catch {
        // silent
      }
    },
    [resolvedRepoPath, scheduleTitlePoke],
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
