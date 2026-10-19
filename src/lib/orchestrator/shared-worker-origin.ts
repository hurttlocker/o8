import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { resolveChatTurnOrigin, type ReviewChatOrigin } from './review-continuation-origin';

/** Called before launch, while the authenticated Fast turn owns the delegation. */
export function captureSharedWorkerOrigin(repoPath: string, threadId: string): ReviewChatOrigin | null {
  const history = readPersistedLlmChat(threadId)?.history;
  const messages = history?.messages ?? [];
  const lastUser = messages.findLastIndex(message => message.role === 'user');
  const turn = messages.slice(lastUser + 1).findLast(message => message.role === 'assistant');
  if (lastUser < 0 || !turn || turn.receipt?.pickedMode !== 'fast') return null;
  const resolution = resolveChatTurnOrigin({ repoPath, threadId, turnId: turn.id });
  // Legacy launches remain visible, but lack authority for an automatic new turn.
  if (resolution.kind !== 'bound' || !resolution.origin.permissionMode) return null;
  return resolution.origin;
}
