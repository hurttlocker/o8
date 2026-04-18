import type { MobileTranscriptEntry } from '@/lib/mobile/types';

const ORCHESTRATOR_TURN_PINS_STORAGE_PREFIX = 'o8:orchestrator:turn-pins:';
const SHARED_TURN_PINS_BUCKET = '__shared__';
const FETCH_PATCH_FLAG = '__cortexOrchestratorTurnPinsFetchPatched';

interface StoredTurnPins {
  [tabId: string]: string[];
}

interface OrchestratorHistoryRecord {
  messages?: Array<Record<string, unknown>>;
  model?: string | null;
  starred?: boolean;
  title?: string | null;
  planText?: string | null;
  repoName?: string | null;
  repoPath?: string | null;
  repoBranch?: string | null;
  remoteUrl?: string | null;
}

interface ChatHistoryListEntry {
  tabId: string;
  modifiedAt?: string;
  repoPath?: string | null;
}

function normalizeRepoPath(repoPath: string | null | undefined) {
  return (repoPath ?? '').trim().replace(/\/+$/, '');
}

function storageKey(repoPath: string | null | undefined) {
  return `${ORCHESTRATOR_TURN_PINS_STORAGE_PREFIX}${normalizeRepoPath(repoPath)}`;
}

function readStoredTurnPins(repoPath: string | null | undefined): StoredTurnPins {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  if (!normalizedRepoPath || typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(normalizedRepoPath)) ?? '{}') as StoredTurnPins;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredTurnPins(repoPath: string | null | undefined, value: StoredTurnPins) {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  if (!normalizedRepoPath || typeof window === 'undefined') return;
  const hasPins = Object.values(value).some((entryIds) => Array.isArray(entryIds) && entryIds.length > 0);
  if (!hasPins) {
    window.localStorage.removeItem(storageKey(normalizedRepoPath));
    return;
  }
  window.localStorage.setItem(storageKey(normalizedRepoPath), JSON.stringify(value));
}

function pinnedIdsFromMessages(messages: Array<Record<string, unknown>>) {
  return messages
    .filter((message) => message.pinned === true && typeof message.id === 'string')
    .map((message) => message.id as string);
}

function syncStoredTurnPins(
  repoPath: string | null | undefined,
  tabId: string | null | undefined,
  messages: Array<Record<string, unknown>>,
) {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const normalizedTabId = (tabId ?? '').trim();
  if (!normalizedRepoPath || !normalizedTabId || typeof window === 'undefined') return;
  const next = { ...readStoredTurnPins(normalizedRepoPath) };
  const pinnedIds = pinnedIdsFromMessages(messages);
  const sharedPinnedIds = new Set(next[SHARED_TURN_PINS_BUCKET] ?? []);
  for (const message of messages) {
    if (typeof message.id === 'string') sharedPinnedIds.delete(message.id);
  }
  if (pinnedIds.length === 0) delete next[normalizedTabId];
  else next[normalizedTabId] = pinnedIds;
  if (sharedPinnedIds.size === 0) delete next[SHARED_TURN_PINS_BUCKET];
  else next[SHARED_TURN_PINS_BUCKET] = Array.from(sharedPinnedIds);
  writeStoredTurnPins(normalizedRepoPath, next);
}

function mergePinnedFlags(
  repoPath: string | null | undefined,
  tabId: string | null | undefined,
  messages: Array<Record<string, unknown>>,
) {
  const storedPins = readStoredTurnPins(repoPath);
  const pinnedIds = new Set([
    ...(storedPins[SHARED_TURN_PINS_BUCKET] ?? []),
    ...(storedPins[(tabId ?? '').trim()] ?? []),
  ]);
  return messages.map((message) => {
    const id = typeof message.id === 'string' ? message.id : '';
    return id ? { ...message, pinned: message.pinned === true || pinnedIds.has(id) } : message;
  });
}

export function stageOrchestratorTurnPin(
  repoPath: string | null | undefined,
  entryId: string,
  pinned: boolean,
) {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const normalizedEntryId = entryId.trim();
  if (!normalizedRepoPath || !normalizedEntryId || typeof window === 'undefined') return;
  const next = { ...readStoredTurnPins(normalizedRepoPath) };
  const sharedPinnedIds = new Set(next[SHARED_TURN_PINS_BUCKET] ?? []);
  if (pinned) sharedPinnedIds.add(normalizedEntryId);
  else sharedPinnedIds.delete(normalizedEntryId);
  if (sharedPinnedIds.size === 0) delete next[SHARED_TURN_PINS_BUCKET];
  else next[SHARED_TURN_PINS_BUCKET] = Array.from(sharedPinnedIds);
  writeStoredTurnPins(normalizedRepoPath, next);
}

function chatHistoryUrl(input: RequestInfo | URL) {
  if (typeof window === 'undefined') return null;
  const value = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  try {
    const url = new URL(value, window.location.origin);
    return url.pathname === '/api/v2/chat-history' ? url : null;
  } catch {
    return null;
  }
}

export function readCachedOrchestratorTurnPin(
  repoPath: string | null | undefined,
  entryId: string,
) {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const normalizedEntryId = entryId.trim();
  if (!normalizedRepoPath || !normalizedEntryId) return false;
  return Object.values(readStoredTurnPins(normalizedRepoPath)).some((entryIds) => entryIds.includes(normalizedEntryId));
}

export function hydrateOrchestratorTurnPinEntry(
  repoPath: string | null | undefined,
  entry: MobileTranscriptEntry,
) {
  const pinned = entry.pinned === true || readCachedOrchestratorTurnPin(repoPath, entry.id);
  entry.pinned = pinned;
  return pinned;
}

export async function persistOrchestratorTurnPin(input: {
  repoPath: string | null | undefined;
  entryId: string;
  pinned: boolean;
}) {
  const normalizedRepoPath = normalizeRepoPath(input.repoPath);
  const normalizedEntryId = input.entryId.trim();
  if (!normalizedRepoPath || !normalizedEntryId) return false;
  stageOrchestratorTurnPin(normalizedRepoPath, normalizedEntryId, input.pinned);

  const listResponse = await fetch('/api/v2/chat-history/list?include=orchestrator', { cache: 'no-store' }).catch(() => null);
  if (!listResponse?.ok) return false;
  const listPayload = await listResponse.json().catch(() => null) as { conversations?: ChatHistoryListEntry[] } | null;
  const candidates = (listPayload?.conversations ?? [])
    .filter((conversation) => conversation.tabId.startsWith('thoughts-') && normalizeRepoPath(conversation.repoPath) === normalizedRepoPath)
    .sort((left, right) => new Date(right.modifiedAt ?? 0).getTime() - new Date(left.modifiedAt ?? 0).getTime());

  for (const candidate of candidates) {
    const historyResponse = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(candidate.tabId)}`, { cache: 'no-store' }).catch(() => null);
    if (!historyResponse?.ok) continue;
    const history = await historyResponse.json().catch(() => null) as OrchestratorHistoryRecord | null;
    if (!Array.isArray(history?.messages)) continue;
    if (!history.messages.some((message) => message.id === normalizedEntryId)) continue;
    const nextMessages = history.messages.map((message) => message.id === normalizedEntryId ? { ...message, pinned: input.pinned } : message);
    syncStoredTurnPins(normalizedRepoPath, candidate.tabId, nextMessages);
    const persistResponse = await fetch('/api/v2/chat-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tabId: candidate.tabId,
        messages: nextMessages,
        model: history.model ?? 'claude-code',
        starred: history.starred ?? false,
        title: history.title ?? undefined,
        planText: history.planText ?? undefined,
        repoName: history.repoName ?? undefined,
        repoPath: history.repoPath ?? normalizedRepoPath,
        repoBranch: history.repoBranch ?? undefined,
        remoteUrl: history.remoteUrl ?? null,
      }),
    }).catch(() => null);
    return Boolean(persistResponse?.ok);
  }

  return false;
}

export function installOrchestratorTurnPinFetchPatch() {
  if (typeof window === 'undefined') return;
  const patchedWindow = window as Window & { [FETCH_PATCH_FLAG]?: boolean };
  if (patchedWindow[FETCH_PATCH_FLAG]) return;
  patchedWindow[FETCH_PATCH_FLAG] = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const url = chatHistoryUrl(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let nextInit = init;

    if (url && method === 'POST' && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body) as {
          tabId?: string;
          repoPath?: string | null;
          messages?: Array<Record<string, unknown>>;
        };
        if (body.tabId && Array.isArray(body.messages)) {
          const messages = mergePinnedFlags(body.repoPath, body.tabId, body.messages);
          syncStoredTurnPins(body.repoPath, body.tabId, messages);
          nextInit = { ...init, body: JSON.stringify({ ...body, messages }) };
        }
      } catch {
        // Ignore non-JSON bodies.
      }
    }

    const response = await originalFetch(input, nextInit);

    if (url && method === 'GET') {
      const tabId = url.searchParams.get('tabId');
      if (tabId) {
        void response.clone().json().then((payload: OrchestratorHistoryRecord) => {
          if (Array.isArray(payload.messages)) {
            syncStoredTurnPins(payload.repoPath, tabId, payload.messages);
          }
        }).catch(() => {});
      }
    }

    return response;
  };
}
