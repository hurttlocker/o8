import { useEffect, useRef, type RefObject } from 'react';
import type { ThoughtsChatPanelHandle } from '@/components/desktop/thoughts/ThoughtsChatPanel';
import type { OrchestratorTurnInjection } from '@/components/desktop/workspace-terminal/types';

export function useOrchestratorTurnInjection(
  panelRef: RefObject<ThoughtsChatPanelHandle | null>,
  injection: OrchestratorTurnInjection | undefined,
  expectedThreadId: string | null | undefined,
  loadedThreadId: string | null,
  waitingForReply: boolean,
) {
  const handledInjectionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!injection?.id || handledInjectionRef.current === injection.id || waitingForReply) return;
    if (expectedThreadId && loadedThreadId !== expectedThreadId) return;
    const attachments = injection.previewImageDataUri
      ? [{ dataUri: injection.previewImageDataUri, name: 'design-mode-capture.png' }]
      : undefined;
    const accepted = panelRef.current?.sendNow(injection.text, { attachments });
    if (accepted) handledInjectionRef.current = injection.id;
  }, [expectedThreadId, injection, loadedThreadId, panelRef, waitingForReply]);
}
