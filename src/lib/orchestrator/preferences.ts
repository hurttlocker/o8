import type { OrchestratorRuntime } from './types';

export const ORCHESTRATOR_RUNTIME_STORAGE_KEY = 'cortex-ide:orchestrator:runtime';
export const ORCHESTRATOR_RUNTIME_EVENT = 'cortex:orchestrator-runtime-changed';

export function readOrchestratorRuntimePreference(): OrchestratorRuntime {
  if (typeof window === 'undefined') return 'codex';
  try {
    return window.localStorage.getItem(ORCHESTRATOR_RUNTIME_STORAGE_KEY) === 'claude-code'
      ? 'claude-code'
      : 'codex';
  } catch {
    return 'codex';
  }
}

export function writeOrchestratorRuntimePreference(runtime: OrchestratorRuntime) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ORCHESTRATOR_RUNTIME_STORAGE_KEY, runtime);
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(ORCHESTRATOR_RUNTIME_EVENT, {
    detail: { runtime },
  }));
}

export function subscribeOrchestratorRuntimePreference(listener: (runtime: OrchestratorRuntime) => void) {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== ORCHESTRATOR_RUNTIME_STORAGE_KEY) return;
    listener(event.newValue === 'claude-code' ? 'claude-code' : 'codex');
  };

  const handleCustom = (event: Event) => {
    const detail = (event as CustomEvent<{ runtime?: OrchestratorRuntime }>).detail;
    listener(detail?.runtime === 'claude-code' ? 'claude-code' : 'codex');
  };

  window.addEventListener('storage', handleStorage);
  window.addEventListener(ORCHESTRATOR_RUNTIME_EVENT, handleCustom as EventListener);

  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(ORCHESTRATOR_RUNTIME_EVENT, handleCustom as EventListener);
  };
}
