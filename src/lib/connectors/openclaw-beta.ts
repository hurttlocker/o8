export const OPENCLAW_BETA_STORAGE_KEY = 'cortex-ide:connector:openclaw-beta';
export const OPENCLAW_BETA_EVENT = 'cortex:openclaw-beta-changed';

export function readOpenClawBetaEnabled() {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(OPENCLAW_BETA_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeOpenClawBetaEnabled(enabled: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(OPENCLAW_BETA_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(OPENCLAW_BETA_EVENT, {
    detail: { enabled },
  }));
}

export function subscribeOpenClawBetaEnabled(listener: (enabled: boolean) => void) {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== OPENCLAW_BETA_STORAGE_KEY) return;
    listener(event.newValue === '1');
  };

  const handleCustom = (event: Event) => {
    const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
    listener(Boolean(detail?.enabled));
  };

  window.addEventListener('storage', handleStorage);
  window.addEventListener(OPENCLAW_BETA_EVENT, handleCustom as EventListener);

  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(OPENCLAW_BETA_EVENT, handleCustom as EventListener);
  };
}

export function appendOpenClawBetaQuery(input: string, enabled: boolean) {
  const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  const url = new URL(input, base);
  url.searchParams.set('includeOpenClaw', enabled ? '1' : '0');

  if (/^https?:\/\//i.test(input)) {
    return url.toString();
  }

  return `${url.pathname}${url.search}${url.hash}`;
}
