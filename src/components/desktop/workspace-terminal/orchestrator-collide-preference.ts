function collideStorageKey(tabId: string): string {
  return `cortex-ide:orchestrator-collide:tab:${tabId}`;
}

export function readStoredCollide(tabId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(collideStorageKey(tabId)) === '1';
  } catch {
    return false;
  }
}

export function persistCollide(tabId: string, enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(collideStorageKey(tabId), enabled ? '1' : '0');
  } catch {
    // ignore
  }
}
