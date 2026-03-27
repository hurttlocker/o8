export const OPENCLAW_BETA_STORAGE_KEY = 'cortex-ide:connector:openclaw-beta';
export const OPENCLAW_BETA_STATUS_STORAGE_KEY = 'cortex-ide:connector:openclaw-beta-status';
export const OPENCLAW_BETA_EVENT = 'cortex:openclaw-beta-changed';

export type OpenClawIntegrationMode = 'auto' | 'enabled' | 'disabled';

export interface OpenClawIntegrationStatus {
  integration: 'openclaw';
  mode: OpenClawIntegrationMode;
  effective_enabled: boolean;
  configured: boolean;
  config_path?: string;
  source?: string;
  from?: string;
  error?: string;
}

function getLegacyEnabledFallback(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(OPENCLAW_BETA_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function normalizeStatus(raw: unknown): OpenClawIntegrationStatus {
  const fallbackEnabled = getLegacyEnabledFallback();
  const object = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const mode = object.mode === 'enabled' || object.mode === 'disabled' || object.mode === 'auto'
    ? object.mode
    : fallbackEnabled ? 'enabled' : 'disabled';
  const explicitEnabled = mode === 'enabled';

  return {
    integration: 'openclaw',
    mode,
    effective_enabled: typeof object.effective_enabled === 'boolean'
      ? (explicitEnabled ? object.effective_enabled : false)
      : explicitEnabled,
    configured: object.configured !== false,
    config_path: typeof object.config_path === 'string' ? object.config_path : undefined,
    source: typeof object.source === 'string' ? object.source : undefined,
    from: typeof object.from === 'string' ? object.from : undefined,
    error: typeof object.error === 'string' ? object.error : undefined,
  };
}

function dispatchStatus(status: OpenClawIntegrationStatus) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPENCLAW_BETA_EVENT, {
    detail: { enabled: status.effective_enabled, status },
  }));
}

export function readOpenClawBetaStatus(): OpenClawIntegrationStatus {
  if (typeof window === 'undefined') {
    return {
      integration: 'openclaw',
      mode: 'disabled',
      effective_enabled: false,
      configured: false,
    };
  }

  try {
    const raw = window.localStorage.getItem(OPENCLAW_BETA_STATUS_STORAGE_KEY);
    if (raw) {
      return normalizeStatus(JSON.parse(raw));
    }
  } catch {
    // Ignore malformed cached state and fall back below.
  }

  const legacyEnabled = getLegacyEnabledFallback();
  return {
    integration: 'openclaw',
    mode: legacyEnabled ? 'enabled' : 'disabled',
    effective_enabled: legacyEnabled,
    configured: false,
  };
}

export function readOpenClawBetaEnabled() {
  return readOpenClawBetaStatus().effective_enabled;
}

export function writeOpenClawBetaStatus(status: OpenClawIntegrationStatus) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(OPENCLAW_BETA_STATUS_STORAGE_KEY, JSON.stringify(status));
    window.localStorage.setItem(OPENCLAW_BETA_STORAGE_KEY, status.effective_enabled ? '1' : '0');
  } catch {
    // ignore storage failures
  }

  dispatchStatus(status);
}

export function writeOpenClawBetaEnabled(enabled: boolean) {
  writeOpenClawBetaStatus({
    integration: 'openclaw',
    mode: enabled ? 'enabled' : 'disabled',
    effective_enabled: enabled,
    configured: true,
  });
}

export async function refreshOpenClawBetaStatus() {
  try {
    const res = await fetch(`/api/v2/cortex/action?command=${encodeURIComponent('integration openclaw --json')}`, {
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Unable to read Cortex OpenClaw integration status.');
    }
    const status = normalizeStatus(data.result ?? data);
    writeOpenClawBetaStatus(status);
    return status;
  } catch (error) {
    const fallback = {
      ...readOpenClawBetaStatus(),
      error: error instanceof Error ? error.message : 'Unable to read Cortex OpenClaw integration status.',
    };
    writeOpenClawBetaStatus(fallback);
    return fallback;
  }
}

export async function setOpenClawBetaMode(mode: OpenClawIntegrationMode) {
  const command = mode === 'enabled'
    ? 'integration openclaw enable'
    : mode === 'disabled'
      ? 'integration openclaw disable'
      : 'integration openclaw auto';

  const res = await fetch('/api/v2/cortex/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Unable to set OpenClaw mode to ${mode}.`);
  }

  return refreshOpenClawBetaStatus();
}

export function subscribeOpenClawBetaStatus(listener: (status: OpenClawIntegrationStatus) => void) {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== OPENCLAW_BETA_STATUS_STORAGE_KEY && event.key !== OPENCLAW_BETA_STORAGE_KEY) return;
    listener(readOpenClawBetaStatus());
  };

  const handleCustom = (event: Event) => {
    const detail = (event as CustomEvent<{ status?: OpenClawIntegrationStatus }>).detail;
    listener(detail?.status ?? readOpenClawBetaStatus());
  };

  window.addEventListener('storage', handleStorage);
  window.addEventListener(OPENCLAW_BETA_EVENT, handleCustom as EventListener);

  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(OPENCLAW_BETA_EVENT, handleCustom as EventListener);
  };
}

export function subscribeOpenClawBetaEnabled(listener: (enabled: boolean) => void) {
  return subscribeOpenClawBetaStatus((status) => listener(status.effective_enabled));
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
