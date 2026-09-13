'use client';

import { useSyncExternalStore } from 'react';
import {
  readUltraEffortEnabled,
  subscribeOrchestratorThinkingPreferences,
} from '@/lib/orchestrator/thinking-preferences';

export function useUltraEffortPreference(): boolean {
  return useSyncExternalStore(subscribeUltraEffortPreference, readUltraEffortEnabled, () => false);
}

const listeners = new Set<() => void>();
let unsubscribeFromPreferences: (() => void) | null = null;

function subscribeUltraEffortPreference(listener: () => void): () => void {
  listeners.add(listener);
  if (!unsubscribeFromPreferences) {
    unsubscribeFromPreferences = subscribeOrchestratorThinkingPreferences(() => {
      listeners.forEach((notify) => notify());
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    unsubscribeFromPreferences?.();
    unsubscribeFromPreferences = null;
  };
}
