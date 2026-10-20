'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';

import { useComposerDictation } from '@/components/desktop/dictation/ComposerDictation';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { ttsEngine } from '@/lib/tts/engine';
import {
  createAgentVoiceTurnState,
  observeAgentVoiceTurn,
} from './agent-voice-turn';

const STORAGE_PREFIX = 'o8:agent-voice-mode:v1:';
const CHANGE_EVENT = 'o8:agent-voice-mode-change';
const memoryPreferences = new Map<string, boolean>();

function readVoiceMode(storageKey: string): boolean {
  const memoryValue = memoryPreferences.get(storageKey);
  if (memoryValue !== undefined) return memoryValue;
  try {
    const value = window.localStorage.getItem(storageKey) === 'true';
    memoryPreferences.set(storageKey, value);
    return value;
  } catch {
    return false;
  }
}

function subscribeVoiceMode(storageKey: string, onStoreChange: () => void): () => void {
  const handleChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === storageKey) onStoreChange();
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== storageKey) return;
    memoryPreferences.set(storageKey, event.newValue === 'true');
    onStoreChange();
  };
  window.addEventListener(CHANGE_EVENT, handleChange);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handleChange);
    window.removeEventListener('storage', handleStorage);
  };
}

interface UseAgentVoiceModeOptions {
  active: boolean;
  dictationOnly?: boolean;
  busy: boolean;
  composerNodeRef: RefObject<HTMLTextAreaElement | null>;
  fillInput: (text: string) => void;
  messages: MobileTranscriptEntry[];
  sendNow: (text: string) => boolean;
  surfaceKey: string;
  composerScopeKey?: string;
}

export function useAgentVoiceMode({
  active,
  dictationOnly = false,
  busy,
  composerNodeRef,
  fillInput,
  messages,
  sendNow,
  surfaceKey,
  composerScopeKey = surfaceKey,
}: UseAgentVoiceModeOptions): {
  enabled: boolean;
  dictationId: string;
  setEnabled: (enabled: boolean) => void;
} {
  const storageKey = `${STORAGE_PREFIX}${surfaceKey}`;
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeVoiceMode(storageKey, onStoreChange),
    [storageKey],
  );
  const getSnapshot = useCallback(() => readVoiceMode(storageKey), [storageKey]);
  const savedEnabled = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const enabled = !dictationOnly && savedEnabled;
  const enabledRef = useRef(enabled);
  const fillInputRef = useRef(fillInput);
  const sendNowRef = useRef(sendNow);
  const turnStateRef = useRef(createAgentVoiceTurnState());
  const turnSurfaceRef = useRef(surfaceKey);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  useEffect(() => {
    fillInputRef.current = fillInput;
  }, [fillInput]);
  useEffect(() => {
    sendNowRef.current = sendNow;
  }, [sendNow]);

  const setEnabled = useCallback((next: boolean) => {
    memoryPreferences.set(storageKey, next);
    enabledRef.current = !dictationOnly && next;
    try {
      window.localStorage.setItem(storageKey, String(next));
    } catch {
      // Voice mode still works for this mount when storage is unavailable.
    }
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { key: storageKey } }));
    if (!next && ttsEngine.state.activeMessageId?.startsWith(`voice-mode:${surfaceKey}:`)) {
      ttsEngine.stop();
    }
  }, [storageKey, surfaceKey, dictationOnly]);

  const dictationId = useComposerDictation({
    active, nodeRef: composerNodeRef, scopeKey: `${surfaceKey}:${composerScopeKey}`,
    onText: text => {
      if (!text) return;
      if (enabledRef.current && sendNowRef.current(text)) return;
      fillInputRef.current(text);
    },
  });

  useEffect(() => {
    if (turnSurfaceRef.current !== surfaceKey) {
      turnSurfaceRef.current = surfaceKey;
      turnStateRef.current = createAgentVoiceTurnState();
    }
    const observation = observeAgentVoiceTurn(turnStateRef.current, {
      active,
      busy,
      enabled,
      messages,
    });
    turnStateRef.current = observation.state;
    if (observation.speak) {
      void ttsEngine.play(
        observation.speak.text,
        `voice-mode:${surfaceKey}:${observation.speak.id}`,
      );
    }
  }, [active, busy, enabled, messages, surfaceKey]);

  return { enabled, setEnabled, dictationId };
}
