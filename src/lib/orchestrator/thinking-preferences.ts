import {
  isManualThinkingEffort,
  type ManualThinkingEffort,
  type ThinkingEffort,
} from './thinking-effort';

export const ORCHESTRATOR_THINKING_OVERRIDE_STORAGE_KEY = 'o8:orchestrator:thinking-effort';
export const ORCHESTRATOR_ADAPTIVE_THINKING_STORAGE_KEY = 'o8:orchestrator:adaptive-thinking';
export const ORCHESTRATOR_THINKING_PREFERENCES_EVENT = 'cortex:orchestrator-thinking-preferences';

export function readStoredOrchestratorThinkingOverride(): ManualThinkingEffort | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(ORCHESTRATOR_THINKING_OVERRIDE_STORAGE_KEY);
    return isManualThinkingEffort(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function writeStoredOrchestratorThinkingOverride(effort: ManualThinkingEffort | null) {
  if (typeof window === 'undefined') return;
  try {
    if (effort) {
      window.localStorage.setItem(ORCHESTRATOR_THINKING_OVERRIDE_STORAGE_KEY, effort);
    } else {
      window.localStorage.removeItem(ORCHESTRATOR_THINKING_OVERRIDE_STORAGE_KEY);
    }
  } catch {
    // ignore storage failures
  }
  dispatchThinkingPreferenceChange();
}

export function readAdaptiveThinkingEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(ORCHESTRATOR_ADAPTIVE_THINKING_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeAdaptiveThinkingEnabled(enabled: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ORCHESTRATOR_ADAPTIVE_THINKING_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore storage failures
  }
  dispatchThinkingPreferenceChange();
}

export function hasStoredOrchestratorThinkingPreference(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return (
      window.localStorage.getItem(ORCHESTRATOR_THINKING_OVERRIDE_STORAGE_KEY) !== null
      || window.localStorage.getItem(ORCHESTRATOR_ADAPTIVE_THINKING_STORAGE_KEY) !== null
    );
  } catch {
    return false;
  }
}

export function resolveInitialOrchestratorThinkingPreferences(defaultEffort: ThinkingEffort) {
  if (hasStoredOrchestratorThinkingPreference()) {
    return {
      adaptiveThinkingEnabled: readAdaptiveThinkingEnabled(),
      thinkingOverride: readStoredOrchestratorThinkingOverride(),
    };
  }

  return {
    adaptiveThinkingEnabled: true,
    thinkingOverride: isManualThinkingEffort(defaultEffort) ? defaultEffort : null,
  };
}

export function subscribeOrchestratorThinkingPreferences(listener: () => void) {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleStorage = (event: StorageEvent) => {
    if (
      event.key === ORCHESTRATOR_THINKING_OVERRIDE_STORAGE_KEY
      || event.key === ORCHESTRATOR_ADAPTIVE_THINKING_STORAGE_KEY
    ) {
      listener();
    }
  };
  const handleCustom = () => {
    listener();
  };

  window.addEventListener('storage', handleStorage);
  window.addEventListener(ORCHESTRATOR_THINKING_PREFERENCES_EVENT, handleCustom);

  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(ORCHESTRATOR_THINKING_PREFERENCES_EVENT, handleCustom);
  };
}

function dispatchThinkingPreferenceChange() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ORCHESTRATOR_THINKING_PREFERENCES_EVENT));
}
