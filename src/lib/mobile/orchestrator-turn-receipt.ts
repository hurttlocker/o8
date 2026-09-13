import { readPersistedLlmChat, writePersistedLlmChat } from '@/lib/llm/chat-history-store';
import type { MobileTurnReceipt } from '@/lib/mobile/types';
import { mergeMobileTurnReceipts } from './turn-receipt';

export function appendMobileOrchestratorTurnWorker(input: {
  tabId: string | null | undefined;
  messageId: string | null | undefined;
  worker: NonNullable<MobileTurnReceipt['workers']>[number];
}): boolean {
  const tabId = input.tabId?.trim();
  const messageId = input.messageId?.trim();
  if (!tabId?.startsWith('thoughts-') || !messageId) return false;

  const persisted = readPersistedLlmChat(tabId);
  if (!persisted) return false;
  const index = persisted.history.messages.findIndex((message) => message.id === messageId);
  if (index < 0) {
    const pending = persisted.history.pendingTurnWorkers ?? {};
    const priorWorkers = pending[messageId] ?? [];
    const workers = new Map(priorWorkers.map((worker) => [worker.packetId, worker]));
    workers.set(input.worker.packetId, input.worker);
    persisted.history.pendingTurnWorkers = {
      ...pending,
      [messageId]: Array.from(workers.values()),
    };
    writePersistedLlmChat(tabId, persisted.history);
    return true;
  }
  const message = persisted.history.messages[index];
  if (!message?.receipt) return false;

  const receipt = mergeMobileTurnReceipts(message.receipt, {
    ...message.receipt,
    workers: [input.worker],
  });
  if (!receipt) return false;
  persisted.history.messages[index] = { ...message, receipt };
  writePersistedLlmChat(tabId, persisted.history);
  return true;
}
