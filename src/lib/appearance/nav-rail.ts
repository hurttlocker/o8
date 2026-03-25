export const NAV_RAIL_HOVER_EXPAND_STORAGE_KEY = 'cortex-ide:appearance:nav-rail-hover-expand';
export const NAV_RAIL_HOVER_EXPAND_EVENT = 'cortex:nav-rail-hover-expand-changed';

export function readNavRailHoverExpandEnabled() {
  if (typeof window === 'undefined') return true;
  try {
    const stored = window.localStorage.getItem(NAV_RAIL_HOVER_EXPAND_STORAGE_KEY);
    return stored == null ? true : stored === '1';
  } catch {
    return true;
  }
}

export function writeNavRailHoverExpandEnabled(enabled: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(NAV_RAIL_HOVER_EXPAND_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(NAV_RAIL_HOVER_EXPAND_EVENT, {
    detail: { enabled },
  }));
}

export function subscribeNavRailHoverExpandEnabled(listener: (enabled: boolean) => void) {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== NAV_RAIL_HOVER_EXPAND_STORAGE_KEY) return;
    listener(event.newValue == null ? true : event.newValue === '1');
  };

  const handleCustom = (event: Event) => {
    const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
    listener(detail?.enabled ?? true);
  };

  window.addEventListener('storage', handleStorage);
  window.addEventListener(NAV_RAIL_HOVER_EXPAND_EVENT, handleCustom as EventListener);

  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(NAV_RAIL_HOVER_EXPAND_EVENT, handleCustom as EventListener);
  };
}
