import path from 'node:path';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { listCurrentIdeRepoPaths, readIdeTerminalStateFiles } from '@/lib/runtime/ide-terminal-state';

export interface IdeLlmChatDescriptor {
  tabId: string;
  sessionKey: string;
  label: string;
  model?: string;
  repoName?: string;
  repoPath?: string;
  scope: string;
  savedAt?: string;
  modifiedAt?: string;
  isCurrentSession: boolean;
  messageCount: number;
  lastMessage?: string;
}

function normalizeLabel(label?: string, repoName?: string, repoPath?: string) {
  const trimmed = label?.trim();
  if (trimmed && trimmed.toLowerCase() !== 'chat') return trimmed;
  const repoLabel = repoName?.trim() || (repoPath?.trim() ? path.basename(repoPath.trim()) : null);
  return repoLabel ? `${repoLabel} · Chat` : 'Chat';
}

export function listIdeLlmChatSessions(): IdeLlmChatDescriptor[] {
  const currentRepoPaths = new Set(listCurrentIdeRepoPaths());
  const descriptors = new Map<string, IdeLlmChatDescriptor>();
  const files = readIdeTerminalStateFiles();

  for (const file of files) {
    try {
      for (const tab of file.tabs ?? []) {
        if (tab.kind !== 'llm-chat') continue;
        if (!tab.id?.trim()) continue;

        const history = readPersistedLlmChat(tab.id);
        const messages = history?.history.messages ?? [];
        const lastMessage = [...messages].reverse().find((entry) => entry.content?.trim())?.content?.trim();
        const next: IdeLlmChatDescriptor = {
          tabId: tab.id,
          sessionKey: `llm-chat:${tab.id}`,
          label: normalizeLabel(tab.label, tab.repoName, tab.repoPath),
          model: history?.history.model,
          repoName: tab.repoName,
          repoPath: tab.repoPath,
          scope: file.scope,
          savedAt: file.savedAt,
          modifiedAt: history?.modifiedAt,
          isCurrentSession: file.activeTabId === tab.id,
          messageCount: messages.length,
          lastMessage,
        };

        const existing = descriptors.get(next.sessionKey);
        if (!existing) {
          descriptors.set(next.sessionKey, next);
          continue;
        }

        const existingTime = new Date(existing.modifiedAt ?? existing.savedAt ?? 0).getTime();
        const nextTime = new Date(next.modifiedAt ?? next.savedAt ?? 0).getTime();
        if (next.isCurrentSession && !existing.isCurrentSession) {
          descriptors.set(next.sessionKey, next);
          continue;
        }
        if (nextTime >= existingTime) {
          descriptors.set(next.sessionKey, next);
        }
      }
    } catch {
      continue;
    }
  }

  return [...descriptors.values()]
    .filter((session) => {
      if (currentRepoPaths.size === 0) return true;
      const repoPath = session.repoPath?.trim();
      const normalizedRepoPath = repoPath ? path.normalize(repoPath).toLowerCase() : null;
      if (!normalizedRepoPath) return false;
      return currentRepoPaths.has(normalizedRepoPath);
    })
    .sort((left, right) => {
      if (left.isCurrentSession && !right.isCurrentSession) return -1;
      if (!left.isCurrentSession && right.isCurrentSession) return 1;
      const leftTime = new Date(left.modifiedAt ?? left.savedAt ?? 0).getTime();
      const rightTime = new Date(right.modifiedAt ?? right.savedAt ?? 0).getTime();
      return rightTime - leftTime;
    });
}
