export type ChatModelBadge = 'FREE' | 'PREMIUM' | 'BYOK';
export type ChatModelId = 'o8-default' | 'claude-max' | 'byo-key';

export interface ChatModelOption {
  id: ChatModelId;
  label: string;
  subtitle: string;
  badge: ChatModelBadge;
}

export const CHAT_MODEL_OPTIONS: ChatModelOption[] = [
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
];

export const DEFAULT_CHAT_MODEL_ID: ChatModelId = 'o8-default';

export function getChatModelOption(id: ChatModelId): ChatModelOption {
  return CHAT_MODEL_OPTIONS.find((option) => option.id === id) ?? CHAT_MODEL_OPTIONS[0];
}

export function isChatModelId(value: string | null | undefined): value is ChatModelId {
  return value === 'o8-default' || value === 'claude-max' || value === 'byo-key';
}

export function chatModelStorageKey(workspaceKey: string): string {
  return `cortex-ide:orchestrator:chat-model:${workspaceKey}`;
}

export function loadChatModelChoice(workspaceKey: string): ChatModelId {
  if (typeof window === 'undefined') return DEFAULT_CHAT_MODEL_ID;
  try {
    const raw = window.localStorage.getItem(chatModelStorageKey(workspaceKey));
    return isChatModelId(raw) ? raw : DEFAULT_CHAT_MODEL_ID;
  } catch {
    return DEFAULT_CHAT_MODEL_ID;
  }
}

export function persistChatModelChoice(workspaceKey: string, id: ChatModelId): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(chatModelStorageKey(workspaceKey), id);
  } catch {
    // ignore
  }
}
