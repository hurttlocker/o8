export const TIMELINE_VISIBLE_STORAGE_KEY = 'cortex-ide:appearance:timeline-visible';
export const TIMELINE_VISIBLE_EVENT = 'cortex:timeline-visible-changed';

export function readTimelineVisible() {
  if (typeof window === 'undefined') return false;
  try {
    const stored = window.localStorage.getItem(TIMELINE_VISIBLE_STORAGE_KEY);
    return stored === '1';
  } catch {
    return false;
  }
}

export function writeTimelineVisible(visible: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TIMELINE_VISIBLE_STORAGE_KEY, visible ? '1' : '0');
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(TIMELINE_VISIBLE_EVENT, {
    detail: { visible },
  }));
}

export function subscribeTimelineVisible(listener: (visible: boolean) => void) {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== TIMELINE_VISIBLE_STORAGE_KEY) return;
    listener(event.newValue === '1');
  };

  const handleCustom = (event: Event) => {
    const detail = (event as CustomEvent<{ visible?: boolean }>).detail;
    listener(detail?.visible ?? false);
  };

  window.addEventListener('storage', handleStorage);
  window.addEventListener(TIMELINE_VISIBLE_EVENT, handleCustom as EventListener);

  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(TIMELINE_VISIBLE_EVENT, handleCustom as EventListener);
  };
}
