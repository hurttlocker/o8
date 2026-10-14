import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import type { QueuedContextCard } from './types';

export const MAX_WORKSPACE_CHAT_DRAFTS = 32;
export const MAX_QUEUED_CONTEXT_CARDS_PER_DRAFT = 8;

export interface WorkspaceChatDraftState {
  draft: string;
  queuedContextCards: QueuedContextCard[];
  retentionWarning?: string;
}

const draftStates = new Map<string, WorkspaceChatDraftState>();
const listeners = new Set<() => void>();
const STORAGE_KEY = 'o8:workspace-drafts:v1';
const EMPTY: WorkspaceChatDraftState = { draft: '', queuedContextCards: [] };
let loaded = false;

function loadDrafts() {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > 2_000_000) return;
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) return;
    for (const entry of rows.slice(-MAX_WORKSPACE_CHAT_DRAFTS)) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || entry[0].length > 4096) continue;
      const value = entry[1] as WorkspaceChatDraftState;
      if (!value || typeof value.draft !== 'string' || !Array.isArray(value.queuedContextCards)) continue;
      if (!value.queuedContextCards.every(card => card && typeof card.id === 'string' && typeof card.text === 'string'
        && typeof card.title === 'string' && Array.isArray(card.meta) && card.meta.every(part => typeof part === 'string'))) continue;
      draftStates.set(entry[0], cloneDraftState(value));
    }
  } catch { /* Private browser storage may be unavailable; keep the memory draft. */ }
}

function persistDrafts() {
  let failed = false;
  try {
    const raw = JSON.stringify([...draftStates]);
    if (raw.length > 2_000_000) throw new Error('Draft storage limit');
    sessionStorage.setItem(STORAGE_KEY, raw);
  } catch { failed = true; try { sessionStorage.removeItem(STORAGE_KEY); } catch {} }
  for (const [key, value] of draftStates) draftStates.set(key, { ...value, retentionWarning: failed ? 'Browser storage is unavailable. Keep this tab open to retain your draft.' : undefined });
  listeners.forEach(listener => listener());
}

function cloneDraftState(state: WorkspaceChatDraftState): WorkspaceChatDraftState {
  return {
    draft: state.draft,
    queuedContextCards: state.queuedContextCards.slice(-MAX_QUEUED_CONTEXT_CARDS_PER_DRAFT),
  };
}

export function readWorkspaceChatDraftState(tabId: string): WorkspaceChatDraftState {
  loadDrafts();
  const state = draftStates.get(tabId);
  if (!state) return { draft: '', queuedContextCards: [] };
  draftStates.delete(tabId);
  draftStates.set(tabId, state);
  return cloneDraftState(state);
}

export function writeWorkspaceChatDraftState(tabId: string, state: WorkspaceChatDraftState): void {
  loadDrafts();
  draftStates.delete(tabId);
  if (state.draft || state.queuedContextCards.length > 0) {
    draftStates.set(tabId, cloneDraftState(state));
  }
  while (draftStates.size > MAX_WORKSPACE_CHAT_DRAFTS) {
    const oldestTabId = draftStates.keys().next().value as string | undefined;
    if (!oldestTabId) break;
    draftStates.delete(oldestTabId);
  }
  persistDrafts();
}

export function clearWorkspaceChatDraftState(tabId: string): void {
  draftStates.delete(tabId);
  persistDrafts();
}

export function useWorkspaceChatDraftRetention(tabId: string) {
  const getSnapshot = useCallback(() => { loadDrafts(); return draftStates.get(tabId) ?? EMPTY; }, [tabId]);
  const state = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
  const updateState = useCallback((next: WorkspaceChatDraftState) => {
    writeWorkspaceChatDraftState(tabId, next);
  }, [tabId]);
  const setDraft = useCallback<Dispatch<SetStateAction<string>>>((update) => {
    const current = readWorkspaceChatDraftState(tabId);
    updateState({ ...current, draft: typeof update === 'function' ? update(current.draft) : update });
  }, [tabId, updateState]);
  const setQueuedContextCards = useCallback<Dispatch<SetStateAction<QueuedContextCard[]>>>((update) => {
    const current = readWorkspaceChatDraftState(tabId);
    updateState({
      ...current,
      queuedContextCards: typeof update === 'function' ? update(current.queuedContextCards) : update,
    });
  }, [tabId, updateState]);
  return { draft: state.draft, setDraft, queuedContextCards: state.queuedContextCards, setQueuedContextCards, retentionWarning: state.retentionWarning };
}

function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

export function resetWorkspaceChatDraftStatesForTests(clearStorage = true): void {
  draftStates.clear();
  loaded = false;
  if (clearStorage) { try { sessionStorage.removeItem(STORAGE_KEY); } catch {} }
}
