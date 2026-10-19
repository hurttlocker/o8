import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { findLeadThreadBinding } from './lead-lifecycle';
import { findLeadTurnByKey, getLeadStatus } from './lead-status';
import { resolveBackendTurnModel } from './turn-model-selection';
import type { QueuedComposerSendRecord } from './composer-queue-types';

/** Rechecked at admission; a saved follow-up never borrows another task's result. */
export function checkComposerQueuePrecondition(item: QueuedComposerSendRecord): void {
  const { routing, afterTaskId } = item.payload;
  if (!routing.pinBackend) return;
  if (routing.collide || resolveBackendTurnModel(routing.backend, routing.model) !== routing.model) {
    throw new Error('The bound runtime or model would change. Confirm the request again.');
  }
  const history = readPersistedLlmChat(item.threadId)?.history;
  const lastAssistant = history?.messages.findLast(message => message.role === 'assistant');
  if ((history?.model && history.model !== routing.model)
    || (lastAssistant?.backend && lastAssistant.backend !== routing.backend)
    || (lastAssistant?.model && lastAssistant.model !== routing.model)) {
    throw new Error('The bound runtime or model changed. Confirm the request again.');
  }
  if (!afterTaskId) return;
  const lead = findLeadThreadBinding(item.threadId);
  if (lead) {
    const turnId = afterTaskId.startsWith('lead-user-') ? afterTaskId.slice('lead-user-'.length)
      : afterTaskId.startsWith('orch-user-')
        ? findLeadTurnByKey(lead.id, `ws:${afterTaskId.slice('orch-user-'.length)}`)?.id : undefined;
    if (!turnId) throw new Error('The original task has no confirmed admission. Inspect the chat.');
    const status = getLeadStatus(lead.id, 0, turnId);
    if (status.lead.routing.backend !== routing.backend || status.lead.routing.model !== routing.model
      || status.latestTurn?.rootTurnId !== status.requestedTurn?.rootTurnId) {
      throw new Error('The original task or runtime changed. Confirm the follow-up again.');
    }
    if (!['completed', 'failed'].includes(status.requestedTurn?.status ?? '')) {
      throw new Error('The original task has no confirmed terminal outcome. Inspect the chat before continuing.');
    }
    return;
  }
  const latestUser = history?.messages.findLast(message => message.role === 'user');
  if (latestUser?.id !== afterTaskId) throw new Error('The original task changed. Confirm the follow-up again.');
  const result = history?.messages.findLast(message => message.role === 'assistant'
    && message.receipt?.terminal?.userMessageId === afterTaskId);
  if (!result?.receipt?.terminal || result.receipt.terminal.outcome === 'unconfirmed') {
    throw new Error('The original task has no confirmed terminal outcome. Inspect the chat before continuing.');
  }
}
