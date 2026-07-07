export function normalizePersistedChatTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 160) : undefined;
}

export function resolvePersistedChatHistoryTitle(input: {
  tabId: unknown;
  existingTitle: unknown;
  incomingTitle: unknown;
}): string | null {
  const existingTitle = normalizePersistedChatTitle(input.existingTitle);
  if (existingTitle) return existingTitle;

  if (typeof input.tabId === 'string' && input.tabId.startsWith('thoughts-')) {
    return null;
  }

  return normalizePersistedChatTitle(input.incomingTitle) ?? null;
}
