import path from 'node:path';
import {
  readPersistedLlmChat,
  writePersistedLlmChat,
  type PersistedLlmChatHistory,
} from '@/lib/llm/chat-history-store';
import { readIdeSurfaceState } from '@/lib/runtime/ide-surface-state';

const DEFAULT_MOBILE_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_MOBILE_OPENAI_MODEL = 'gpt-5.4';
const DEFAULT_MOBILE_CHAT_TITLE = 'Chat';

export function createMobileLlmTabId() {
  return `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultMobileLlmModel() {
  return process.env.GOOGLE_AI_API_KEY?.trim()
    ? DEFAULT_MOBILE_GEMINI_MODEL
    : DEFAULT_MOBILE_OPENAI_MODEL;
}

export function providerForLlmModel(model?: string): 'openai' | 'anthropic' | 'google' {
  const normalized = model?.trim();
  if (!normalized) {
    return process.env.GOOGLE_AI_API_KEY?.trim() ? 'google' : 'openai';
  }
  if (normalized.startsWith('claude-')) return 'anthropic';
  if (normalized.startsWith('gemini-')) return 'google';
  return 'openai';
}

function resolveMobileChatRepoContext() {
  const surfaceState = readIdeSurfaceState();
  const repoPath = surfaceState?.activeRepoPath ?? surfaceState?.terminalRepoPaths[0] ?? undefined;
  return {
    repoPath,
    repoName: repoPath ? path.basename(repoPath) : undefined,
  };
}

export function ensurePersistedMobileLlmChatSession(
  tabId: string,
  overrides: {
    model?: string;
    title?: string;
    repoPath?: string;
    repoName?: string;
  } = {},
) {
  const existing = readPersistedLlmChat(tabId)?.history;
  const repoContext = resolveMobileChatRepoContext();

  const nextHistory: PersistedLlmChatHistory = {
    ...(existing ?? { messages: [] }),
    model: overrides.model?.trim() || existing?.model || defaultMobileLlmModel(),
    title: overrides.title?.trim() || existing?.title || DEFAULT_MOBILE_CHAT_TITLE,
    repoPath: overrides.repoPath?.trim() || existing?.repoPath || repoContext.repoPath,
    repoName: overrides.repoName?.trim() || existing?.repoName || repoContext.repoName,
  };

  if (
    !existing
    || existing.model !== nextHistory.model
    || existing.title !== nextHistory.title
    || existing.repoPath !== nextHistory.repoPath
    || existing.repoName !== nextHistory.repoName
  ) {
    writePersistedLlmChat(tabId, nextHistory);
  }

  return readPersistedLlmChat(tabId)?.history ?? nextHistory;
}

export function cleanProxyContent(text: string) {
  return text
    .replace(/^I'll use the \w+ tool[^\n]*\n*/gm, '')
    .replace(/^I'll use the \w+ tool[^\n]*/gm, '')
    .replace(/^Let me use[^\n]*tool[^\n]*\n*/gm, '')
    .trim();
}

export function buildLlmRequestMessages(history: PersistedLlmChatHistory, nextUserContent: string) {
  const cleanMessages = (history.messages ?? [])
    .filter((message) => {
      if (message.isError || message.isPartial) return false;
      if (!message.content?.trim()) return false;
      if (message.content.startsWith('Error: ')) return false;
      if (message.content.startsWith('Action cancelled:')) return false;
      return true;
    })
    .map((message) => ({ role: message.role, content: message.content }));

  const recentMessages = cleanMessages.length > 40
    ? cleanMessages.slice(-40)
    : cleanMessages;

  return [
    ...recentMessages,
    { role: 'user', content: nextUserContent },
  ];
}
