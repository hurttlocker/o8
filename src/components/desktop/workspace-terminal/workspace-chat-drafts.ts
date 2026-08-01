import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { QueuedContextCard } from './types';

export const MAX_WORKSPACE_CHAT_DRAFTS = 32;
export const MAX_QUEUED_CONTEXT_CARDS_PER_DRAFT = 8;

export interface WorkspaceChatDraftState {
  draft: string;
  queuedContextCards: QueuedContextCard[];
}

const draftStates = new Map<string, WorkspaceChatDraftState>();

function cloneDraftState(state: WorkspaceChatDraftState): WorkspaceChatDraftState {
  return {
    draft: state.draft,
    queuedContextCards: state.queuedContextCards.slice(-MAX_QUEUED_CONTEXT_CARDS_PER_DRAFT),
  };
}

export function readWorkspaceChatDraftState(tabId: string): WorkspaceChatDraftState {
  const state = draftStates.get(tabId);
  if (!state) return { draft: '', queuedContextCards: [] };
  draftStates.delete(tabId);
  draftStates.set(tabId, state);
  return cloneDraftState(state);
}

export function writeWorkspaceChatDraftState(tabId: string, state: WorkspaceChatDraftState): void {
  draftStates.delete(tabId);
  if (state.draft || state.queuedContextCards.length > 0) {
    draftStates.set(tabId, cloneDraftState(state));
  }
  while (draftStates.size > MAX_WORKSPACE_CHAT_DRAFTS) {
    const oldestTabId = draftStates.keys().next().value as string | undefined;
    if (!oldestTabId) break;
    draftStates.delete(oldestTabId);
  }
}

export function clearWorkspaceChatDraftState(tabId: string): void {
  draftStates.delete(tabId);
}

export function useWorkspaceChatDraftRetention(tabId: string) {
  const [initialState] = useState(() => readWorkspaceChatDraftState(tabId));
  const stateRef = useRef(initialState);
  const [state, setState] = useState(initialState);
  const updateState = useCallback((next: WorkspaceChatDraftState) => {
    const retained = cloneDraftState(next);
    stateRef.current = retained;
    writeWorkspaceChatDraftState(tabId, retained);
    setState(retained);
  }, [tabId]);
  const setDraft = useCallback<Dispatch<SetStateAction<string>>>((update) => {
    const current = stateRef.current;
    updateState({ ...current, draft: typeof update === 'function' ? update(current.draft) : update });
  }, [updateState]);
  const setQueuedContextCards = useCallback<Dispatch<SetStateAction<QueuedContextCard[]>>>((update) => {
    const current = stateRef.current;
    updateState({
      ...current,
      queuedContextCards: typeof update === 'function' ? update(current.queuedContextCards) : update,
    });
  }, [updateState]);
  useEffect(() => () => writeWorkspaceChatDraftState(tabId, stateRef.current), [tabId]);
  return { draft: state.draft, setDraft, queuedContextCards: state.queuedContextCards, setQueuedContextCards };
}

export function resetWorkspaceChatDraftStatesForTests(): void {
  draftStates.clear();
}
