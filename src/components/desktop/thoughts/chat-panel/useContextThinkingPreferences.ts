'use client';

import { useEffect, useState } from 'react';
import { readAdaptiveThinkingEnabled, readStoredOrchestratorThinkingOverride, resolveInitialOrchestratorThinkingPreferences, subscribeOrchestratorThinkingPreferences } from '@/lib/orchestrator/thinking-preferences';
import type { ManualThinkingEffort, ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { ContextualConversation } from './contextual-turn';

/** Reply conversations own their choices; normal composers follow saved preferences. */
export function useContextThinkingPreferences(defaultEffort: ThinkingEffort, conversation?: ContextualConversation) {
  const [adaptiveThinkingEnabled, setAdaptiveThinkingEnabled] = useState(() => conversation?.modelDefaults ? false : resolveInitialOrchestratorThinkingPreferences(defaultEffort).adaptiveThinkingEnabled);
  const [thinkingOverride, setThinkingOverride] = useState<ManualThinkingEffort | null>(() => conversation?.modelDefaults?.effort ?? resolveInitialOrchestratorThinkingPreferences(defaultEffort).thinkingOverride);
  useEffect(() => conversation ? undefined : subscribeOrchestratorThinkingPreferences(() => {
    setAdaptiveThinkingEnabled(readAdaptiveThinkingEnabled());
    setThinkingOverride(readStoredOrchestratorThinkingOverride());
  }), [conversation]);
  return { adaptiveThinkingEnabled, setAdaptiveThinkingEnabled, thinkingOverride, setThinkingOverride };
}
