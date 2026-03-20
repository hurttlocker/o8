/**
 * LLM Chat message persistence.
 *
 * Saves/loads chat messages per tab ID via API route.
 * Messages survive page refresh and app restart.
 */

import type { LLMMessage } from '@/components/desktop/LLMChat';

const API_PATH = '/api/v2/chat-history';

/** Save messages for a tab */
export async function saveChatHistory(tabId: string, messages: LLMMessage[], model?: string): Promise<void> {
  try {
    await fetch(API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId, messages, model }),
    });
  } catch { /* non-critical */ }
}

/** Load messages for a tab */
export async function loadChatHistory(tabId: string): Promise<{ messages: LLMMessage[]; model?: string } | null> {
  try {
    const res = await fetch(`${API_PATH}?tabId=${encodeURIComponent(tabId)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Delete history for a tab */
export async function deleteChatHistory(tabId: string): Promise<void> {
  try {
    await fetch(`${API_PATH}?tabId=${encodeURIComponent(tabId)}`, { method: 'DELETE' });
  } catch { /* ignore */ }
}
