import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { hasQueuedOrchestratorSessionPrelude } from '@/lib/orchestrator/store';
import { appendOrchestratorDeliveryFailureEntry } from './delivery';

/** Refuse before consuming a draft when its saved context cannot be read. */
export function canReadSessionContext(
  repoPath: string | null,
  threadId: string | null,
  setMessages: Dispatch<SetStateAction<MobileTranscriptEntry[]>>,
  messagesRef: MutableRefObject<MobileTranscriptEntry[]>,
): boolean {
  try {
    hasQueuedOrchestratorSessionPrelude(repoPath, threadId);
    return true;
  } catch {
    appendOrchestratorDeliveryFailureEntry(setMessages, messagesRef, {
      id: `orch-send-blocked-${Date.now()}`,
      reason: 'Chat storage is unavailable. Your message is still in the composer. Restore storage access, then send again.',
    });
    return false;
  }
}
