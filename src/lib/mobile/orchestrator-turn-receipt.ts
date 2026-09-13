import {
  persistCanonicalChatHistoryRecordUnlocked,
  readPersistedLlmChat,
  withCanonicalChatHistoryLock,
} from '@/lib/llm/chat-history-store';
import type { MobileTurnReceipt } from '@/lib/mobile/types';
import {
  appendPendingTurnWorker,
  mergeMobileTurnReceipts,
} from './turn-receipt';

export function appendMobileOrchestratorTurnWorker(input: {
  tabId: string | null | undefined;
  messageId: string | null | undefined;
  worker: NonNullable<MobileTurnReceipt['workers']>[number];
}): boolean {
  const tabId = input.tabId?.trim();
  const messageId = input.messageId?.trim();
  if (!tabId?.startsWith('thoughts-') || !messageId) return false;

  return withCanonicalChatHistoryLock(tabId, () => {
    const persisted = readPersistedLlmChat(tabId);
    if (!persisted) return false;
    const index = persisted.history.messages.findIndex((message) => message.id === messageId);
    const message = persisted.history.messages[index];
    const modifiedAt = new Date().toISOString();
    if (!message?.receipt) {
      persistCanonicalChatHistoryRecordUnlocked(tabId, {
        ...persisted.history,
        savedAt: modifiedAt,
        pendingTurnWorkers: appendPendingTurnWorker(
          persisted.history.pendingTurnWorkers,
          messageId,
          input.worker,
        ),
      }, modifiedAt);
      return true;
    }

    const receipt = mergeMobileTurnReceipts(message.receipt, {
      ...message.receipt,
      workers: [input.worker],
    });
    if (!receipt) return false;
    persisted.history.messages[index] = { ...message, receipt };
    persistCanonicalChatHistoryRecordUnlocked(tabId, {
      ...persisted.history,
      savedAt: modifiedAt,
    }, modifiedAt);
    return true;
  });
}
