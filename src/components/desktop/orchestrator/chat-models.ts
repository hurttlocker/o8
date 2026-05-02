'use client';

export const CHAT_MODEL_OPTIONS = [
  {
    id: 'o8-default',
    label: 'o8 Default',
    subtitle: 'Free, fast — great for chatting about o8 and quick questions.',
    badge: 'FREE',
  },
  {
    id: 'claude-max',
    label: 'Your Claude Max',
    subtitle: 'Premium quality. Uses your Claude subscription.',
    badge: 'PREMIUM',
  },
  {
    id: 'byo-key',
    label: 'Bring your own key',
    subtitle: 'Route through your own API key from Settings.',
    badge: 'BYOK',
  },
] as const;

export type ChatModelOption = (typeof CHAT_MODEL_OPTIONS)[number];
export type ChatModelId = ChatModelOption['id'];
export type ChatModelBadge = ChatModelOption['badge'];

export const DEFAULT_CHAT_MODEL_ID: ChatModelId = 'o8-default';

function storageKey(workspaceKey: string): string {
  return `cortex-ide:orchestrator:chat-model:${workspaceKey}`;
}

export function isChatModelId(value: string | null | undefined): value is ChatModelId {
  return CHAT_MODEL_OPTIONS.some((option) => option.id === value);
}

export function getChatModelOption(id: ChatModelId): ChatModelOption {
  return CHAT_MODEL_OPTIONS.find((option) => option.id === id) ?? CHAT_MODEL_OPTIONS[0];
}

export function loadChatModelChoice(workspaceKey: string): ChatModelId {
  if (typeof window === 'undefined') return DEFAULT_CHAT_MODEL_ID;
  try {
    const stored = window.localStorage.getItem(storageKey(workspaceKey));
    return isChatModelId(stored) ? stored : DEFAULT_CHAT_MODEL_ID;
  } catch {
    return DEFAULT_CHAT_MODEL_ID;
  }
}

export function persistChatModelChoice(workspaceKey: string, modelId: ChatModelId): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(workspaceKey), modelId);
  } catch {
    // ignore quota / privacy mode
  }
}
