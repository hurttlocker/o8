/**
 * Browser-side push subscription helpers — mounted from the mobile shell.
 *
 * Flow:
 *   1. registerPushServiceWorker() — install /sw-push.js once on mount
 *   2. enablePush() — request Notification permission, fetch VAPID public
 *      key, call pushManager.subscribe(), POST to /api/mobile/push/subscribe
 *   3. disablePush() — unsubscribe + DELETE the row
 *
 * All gated fetches include the `meta[name="ws-token"]` Bearer header so
 * mobile-over-LAN/Tailscale works.
 *
 * Issue: https://github.com/hurttlocker/cortex-ide/issues/639
 */

const SW_PATH = '/sw-push.js';
const STORAGE_KEY = 'o8:mobile:push:enabled';

export type PushSupport =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'tauri' | 'no-window' };

export type EnableResult =
  | { ok: true; endpoint: string }
  | { ok: false; reason: 'denied' | 'no-vapid-key' | 'subscribe-failed' | 'server-rejected'; detail?: string };

function readWsToken(): string | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector('meta[name="ws-token"]')?.getAttribute('content') ?? null;
}

function authHeaders(): Record<string, string> {
  const token = readWsToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function detectPushSupport(): PushSupport {
  if (typeof window === 'undefined') {
    return { ok: false, reason: 'no-window' };
  }
  // Push is unavailable inside the Tauri webview — desktop has its own
  // notifications via @tauri-apps/plugin-notification.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tauri = Boolean((window as any).__TAURI_INTERNALS__);
  if (tauri) {
    return { ok: false, reason: 'tauri' };
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { ok: false, reason: 'unsupported' };
  }
  return { ok: true };
}

export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  const support = detectPushSupport();
  if (!support.ok) return null;
  try {
    const reg = await navigator.serviceWorker.register(SW_PATH, { scope: '/' });
    // Wait for activation so subscribe() doesn't race the install.
    if (reg.installing) {
      await new Promise<void>((resolve) => {
        const worker = reg.installing!;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated' || worker.state === 'redundant') {
            resolve();
          }
        });
      });
    }
    return reg;
  } catch (error) {
    console.warn('[push-client] service worker registration failed', error);
    return null;
  }
}

async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const res = await fetch('/api/mobile/push/public-key', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { publicKey?: string };
    return data.publicKey ?? null;
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replaceAll('-', '+').replaceAll('_', '/');
  const raw = window.atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer | null | undefined): string {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function isPushEnabled(): Promise<boolean> {
  const support = detectPushSupport();
  if (!support.ok) return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
    if (!reg) return false;
    const sub = await reg.pushManager.getSubscription();
    return Boolean(sub);
  } catch {
    return false;
  }
}

export function readStoredPushEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStoredPushEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

export async function enablePush(opts: { label?: string } = {}): Promise<EnableResult> {
  const support = detectPushSupport();
  if (!support.ok) {
    return { ok: false, reason: 'subscribe-failed', detail: `unsupported (${support.reason})` };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, reason: 'denied' };
  }

  const reg = await registerPushServiceWorker();
  if (!reg) {
    return { ok: false, reason: 'subscribe-failed', detail: 'service worker registration failed' };
  }

  const publicKey = await fetchVapidPublicKey();
  if (!publicKey) {
    return { ok: false, reason: 'no-vapid-key' };
  }

  let sub: PushSubscription;
  try {
    const existing = await reg.pushManager.getSubscription();
    sub = existing ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  } catch (error) {
    console.warn('[push-client] pushManager.subscribe failed', error);
    return {
      ok: false,
      reason: 'subscribe-failed',
      detail: error instanceof Error ? error.message : 'unknown',
    };
  }

  const json = sub.toJSON();
  const body = {
    endpoint: sub.endpoint,
    keys: {
      p256dh: typeof json.keys?.p256dh === 'string'
        ? json.keys.p256dh
        : arrayBufferToBase64Url(sub.getKey('p256dh') as ArrayBuffer | null),
      auth: typeof json.keys?.auth === 'string'
        ? json.keys.auth
        : arrayBufferToBase64Url(sub.getKey('auth') as ArrayBuffer | null),
    },
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    label: opts.label,
  };

  try {
    const res = await fetch('/api/mobile/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, reason: 'server-rejected', detail: `${res.status} ${text}` };
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'server-rejected',
      detail: error instanceof Error ? error.message : 'fetch failed',
    };
  }

  writeStoredPushEnabled(true);
  return { ok: true, endpoint: sub.endpoint };
}

export async function disablePush(): Promise<{ ok: boolean }> {
  const support = detectPushSupport();
  if (!support.ok) return { ok: true };

  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
    if (!reg) {
      writeStoredPushEnabled(false);
      return { ok: true };
    }
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      try {
        await fetch('/api/mobile/push/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
      } catch {
        // best-effort — keep going so we still unsubscribe locally
      }
      try {
        await sub.unsubscribe();
      } catch {
        // ignore
      }
    }
    writeStoredPushEnabled(false);
    return { ok: true };
  } catch (error) {
    console.warn('[push-client] disablePush failed', error);
    return { ok: false };
  }
}

/**
 * Parse a deep-link URL forwarded by sw-push.js — returns the `view` query
 * param (typed as string, since `MobileView` lives in the shared module).
 */
export function parsePushDeepLinkView(url: string): string | null {
  try {
    const parsed = new URL(url, typeof window === 'undefined' ? 'https://localhost' : window.location.origin);
    return parsed.searchParams.get('view');
  } catch {
    return null;
  }
}

/**
 * Hook helper — call once on mobile mount to register the SW and listen
 * for notification-click deep-link messages forwarded from sw-push.js.
 *
 * Returns a cleanup function. No-ops in Tauri / unsupported browsers.
 */
export function attachPushHandlers(onDeepLink: (url: string) => void): () => void {
  const support = detectPushSupport();
  if (!support.ok) return () => undefined;

  let cancelled = false;
  void (async () => {
    if (cancelled) return;
    await registerPushServiceWorker();
  })();

  function onMessage(event: MessageEvent) {
    const data = event.data as { kind?: string; url?: string } | undefined;
    if (!data || data.kind !== 'o8-push-deeplink' || typeof data.url !== 'string') return;
    onDeepLink(data.url);
  }

  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => {
    cancelled = true;
    navigator.serviceWorker.removeEventListener('message', onMessage);
  };
}

export async function sendTestPush(): Promise<{ ok: boolean; delivered?: number; failed?: number; detail?: string }> {
  try {
    const res = await fetch('/api/mobile/push/test', {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, detail: `${res.status} ${text}` };
    }
    const data = (await res.json()) as { delivered?: number; failed?: number };
    return { ok: true, delivered: data.delivered, failed: data.failed };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'fetch failed' };
  }
}
