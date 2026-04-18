import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { buildOrchestratorArchiveTitle } from '@/lib/orchestrator/history-transcript';

const TOAST_DURATION_MS = 1800;

type Deps = {
  isOrchestratorMode: boolean;
  orchStreamMessages: MobileTranscriptEntry[];
  orchStreamPlanText: string | null;
  chatMessages: MobileTranscriptEntry[];
  planText: string | null;
  threadIdRef: RefObject<string | null>;
  resolvedRepoPath: string | null;
  persistThreadNow: (
    msgs: MobileTranscriptEntry[],
    tid: string | null,
    planText: string | null,
    options?: { title?: string | null },
  ) => Promise<void>;
  cancelPendingPersist: () => void;
  handleReset: () => void;
};

function buildArchiveSnapshot(deps: Deps) {
  const {
    isOrchestratorMode, orchStreamMessages, orchStreamPlanText,
    chatMessages, planText,
  } = deps;
  const liveTimestamps = new Set(orchStreamMessages.map((entry) => entry.timestamp));
  const archivedPlanText = planText ?? orchStreamPlanText ?? null;
  const archiveMessages = isOrchestratorMode
    ? (orchStreamMessages.length > 0 && chatMessages.length > 0
      ? [...chatMessages.filter((m) => !liveTimestamps.has(m.timestamp)), ...orchStreamMessages]
      : orchStreamMessages.length > 0
        ? orchStreamMessages
        : chatMessages)
    : chatMessages;
  return { archiveMessages, archivedPlanText };
}

export function useClearCommand(deps: Deps) {
  const [showClearToast, setShowClearToast] = useState(false);
  const toastTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const showArchivedToast = useCallback(() => {
    setShowClearToast(true);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setShowClearToast(false);
      toastTimerRef.current = null;
    }, TOAST_DURATION_MS);
  }, []);

  const handleClearCommand = useCallback(async () => {
    const { archiveMessages, archivedPlanText } = buildArchiveSnapshot(deps);
    const hasArchivableMessages = archiveMessages.some((message) => (
      (message.role === 'user' || message.role === 'assistant' || message.role === 'tool')
      && message.type !== 'command'
      && message.text.trim().length > 0
    ));

    deps.cancelPendingPersist();
    if (hasArchivableMessages) {
      await deps.persistThreadNow(
        archiveMessages,
        deps.threadIdRef.current ?? `thoughts-${Date.now()}`,
        archivedPlanText,
        {
          title: buildOrchestratorArchiveTitle({
            messages: archiveMessages,
            planText: archivedPlanText,
          }),
        },
      );
    }

    try {
      const response = await fetch('/api/orchestrator/reset-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deps.resolvedRepoPath ? { repoPath: deps.resolvedRepoPath } : {}),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? 'Unable to reset orchestrator session.');
      }
      deps.handleReset();
      showArchivedToast();
    } catch (error) {
      console.error('[orchestrator] Failed to clear orchestrator conversation.', error);
    }
  }, [deps, showArchivedToast]);

  return { showClearToast, handleClearCommand };
}
