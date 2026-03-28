import type { MobileHistoryResponse } from '@/lib/mobile/types';
import { mapLlmHistoryToMobileTranscript, readPersistedLlmChat } from '@/lib/llm/chat-history-store';

export function loadMobileLlmChatHistory(sessionKey: string, limit?: number): MobileHistoryResponse {
  const tabId = sessionKey.replace(/^llm-chat:/, '');
  const record = readPersistedLlmChat(tabId);
  if (!record) {
    return {
      sessionKey,
      transcript: [],
    };
  }

  return {
    sessionKey,
    transcript: mapLlmHistoryToMobileTranscript(record.history.messages, limit),
  };
}
