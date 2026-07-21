import type { OrchestratorRuntime } from './types';
import { isDispatchableRuntime } from './runtime-capabilities';

export const ORCHESTRATOR_RUNTIME_STORAGE_KEY = 'o8:orchestrator:runtime';
export const ORCHESTRATOR_RUNTIME_EVENT = 'cortex:orchestrator-runtime-changed';

function coerceRuntime(value: string | null | undefined): OrchestratorRuntime {
  return isDispatchableRuntime(value) ? value : 'codex';
}

export function readOrchestratorRuntimePreference(): OrchestratorRuntime {
  if (typeof window === 'undefined') return 'codex';
  try {
    return coerceRuntime(window.localStorage.getItem(ORCHESTRATOR_RUNTIME_STORAGE_KEY));
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
    listener(coerceRuntime(event.newValue));
  };

  const handleCustom = (event: Event) => {
    const detail = (event as CustomEvent<{ runtime?: OrchestratorRuntime }>).detail;
    listener(coerceRuntime(detail?.runtime));
  };

  window.addEventListener('storage', handleStorage);
  window.addEventListener(ORCHESTRATOR_RUNTIME_EVENT, handleCustom as EventListener);

  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(ORCHESTRATOR_RUNTIME_EVENT, handleCustom as EventListener);
  };
}
