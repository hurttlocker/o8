/**
 * LLM Chat message persistence.
 *
 * Saves/loads chat messages per tab ID via API route.
 * Messages survive page refresh and app restart.
 */

import type { LLMMessage } from '@/components/desktop/LLMChat';

const API_PATH = '/api/v2/chat-history';

export interface SavedChatRepoContext {
  name?: string;
  localPath?: string;
  branch?: string | null;
  remoteUrl?: string | null;
}

/** Save messages for a tab */
export async function saveChatHistory(
  tabId: string,
  messages: LLMMessage[],
  model?: string,
  repo?: SavedChatRepoContext | null,
): Promise<void> {
  try {
    await fetch(API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        tabId,
        messages,
        model,
        repoName: repo?.name,
        repoPath: repo?.localPath,
        repoBranch: repo?.branch ?? undefined,
        remoteUrl: repo?.remoteUrl ?? undefined,
      }),
    });
  } catch { /* non-critical */ }
}

/** Load messages for a tab */
export async function loadChatHistory(tabId: string): Promise<{
  messages: LLMMessage[];
  model?: string;
  repoName?: string;
  repoPath?: string;
  repoBranch?: string;
  remoteUrl?: string | null;
} | null> {
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
