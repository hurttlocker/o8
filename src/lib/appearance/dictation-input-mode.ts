/**
 * Persisted choice for how the dictation mic button responds to clicks.
 *
 *   'toggle' — DEFAULT. Tap once to start, tap again to stop & submit.
 *   'hold'   — Press and hold to record, release to stop & submit.
 *
 * The keyboard shortcut (Ctrl+Z) always uses hold semantics regardless
 * of this setting — keyboards naturally hold-to-fire.
 */

export type DictationInputMode = 'toggle' | 'hold';

export const DICTATION_INPUT_MODE_STORAGE_KEY = 'o8:dictation:input-mode';
export const DICTATION_INPUT_MODE_EVENT = 'o8:dictation-input-mode-changed';
export const DEFAULT_DICTATION_INPUT_MODE: DictationInputMode = 'toggle';

function isMode(value: unknown): value is DictationInputMode {
  return value === 'toggle' || value === 'hold';
}

export function readDictationInputMode(): DictationInputMode {
  if (typeof window === 'undefined') return DEFAULT_DICTATION_INPUT_MODE;
  try {
    const stored = window.localStorage.getItem(DICTATION_INPUT_MODE_STORAGE_KEY);
    return isMode(stored) ? stored : DEFAULT_DICTATION_INPUT_MODE;
  } catch {
    return DEFAULT_DICTATION_INPUT_MODE;
  }
}

export function writeDictationInputMode(mode: DictationInputMode) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DICTATION_INPUT_MODE_STORAGE_KEY, mode);
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(DICTATION_INPUT_MODE_EVENT, {
    detail: { mode },
  }));
}

export function subscribeDictationInputMode(listener: (mode: DictationInputMode) => void) {
  if (typeof window === 'undefined') return () => {};

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== DICTATION_INPUT_MODE_STORAGE_KEY) return;
    listener(isMode(event.newValue) ? event.newValue : DEFAULT_DICTATION_INPUT_MODE);
  };

  const handleCustom = (event: Event) => {
    const detail = (event as CustomEvent<{ mode?: DictationInputMode }>).detail;
    listener(detail?.mode ?? DEFAULT_DICTATION_INPUT_MODE);
  };

  window.addEventListener('storage', handleStorage);
  window.addEventListener(DICTATION_INPUT_MODE_EVENT, handleCustom as EventListener);

  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(DICTATION_INPUT_MODE_EVENT, handleCustom as EventListener);
  };
}
