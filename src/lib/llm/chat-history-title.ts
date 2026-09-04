export function normalizePersistedChatTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 160) : undefined;
}

/**
 * Mission snapshots minted by `archiveMissionThread` — a `thoughts-` id ending
 * in `-archive`. They are the one thoughts- record class whose title is authored
 * deliberately (from the mission's merged packets) rather than swept up from
 * autosave.
 */
export function isMissionArchiveTabId(tabId: unknown): tabId is string {
  return typeof tabId === 'string' && tabId.startsWith('thoughts-') && tabId.endsWith('-archive');
}

export function resolvePersistedChatHistoryTitle(input: {
  tabId: unknown;
  existingTitle: unknown;
  incomingTitle: unknown;
}): string | null {
  const existingTitle = normalizePersistedChatTitle(input.existingTitle);
  if (existingTitle) return existingTitle;

  const incomingTitle = normalizePersistedChatTitle(input.incomingTitle);

  // A live orchestrator thread autosaves with prompt text in `title`, so
  // thoughts- records drop incoming titles and let the auto-titler name them.
  // Mission archives are the exception (#1848): dropping their title leaves the
  // snapshot nameless, and the auto-titler then falls back to the thread's first
  // user message — so successive snapshots cut from one long-lived thread all
  // read alike instead of naming what their mission actually did.
  if (isMissionArchiveTabId(input.tabId)) return incomingTitle ?? null;

  if (typeof input.tabId === 'string' && input.tabId.startsWith('thoughts-')) {
    return null;
  }

  return incomingTitle ?? null;
}
