import type { ComposerMode } from './composer-mode';

const COMPOSER_MODE_STORAGE_PREFIX = 'cortex-ide:orchestrator-composer-mode:tab:';
const LEGACY_SWARM_STORAGE_PREFIX = 'cortex-ide:orchestrator-swarm:tab:';

export function composerModeStorageKey(tabId: string): string {
  return `${COMPOSER_MODE_STORAGE_PREFIX}${tabId}`;
}

export function legacySwarmStorageKey(tabId: string): string {
  return `${LEGACY_SWARM_STORAGE_PREFIX}${tabId}`;
}

function isComposerMode(value: string | null): value is ComposerMode {
  return value === 'solo' || value === 'multitask' || value === 'moa' || value === 'fusion';
}

export function readStoredComposerMode(tabId: string): ComposerMode {
  if (typeof window === 'undefined') return 'solo';
  try {
    const stored = window.localStorage.getItem(composerModeStorageKey(tabId));
    if (isComposerMode(stored)) {
      if (window.localStorage.getItem(legacySwarmStorageKey(tabId)) === '1') {
        window.localStorage.setItem(legacySwarmStorageKey(tabId), '0');
      }
      return stored;
    }
    if (window.localStorage.getItem(legacySwarmStorageKey(tabId)) !== '1') return 'solo';
    window.localStorage.setItem(composerModeStorageKey(tabId), 'fusion');
    window.localStorage.setItem(legacySwarmStorageKey(tabId), '0');
    return 'fusion';
  } catch {
    return 'solo';
  }
}

export function writeStoredComposerMode(tabId: string, mode: ComposerMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(composerModeStorageKey(tabId), mode);
  } catch {
    // Storage is optional; the in-session mode remains authoritative.
  }
}
