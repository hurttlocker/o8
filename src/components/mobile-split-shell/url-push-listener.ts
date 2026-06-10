/**
 * Mobile dev-host URL-push listener.
 *
 * Subscribes to the `mobile-dev-host` WS channel (broadcast from
 * `/api/mobile/push-url` via the ws-server `/internal/mobile-url-push`
 * endpoint) and re-fans each event out as a `o8:mobile-url-push` window
 * CustomEvent so the DevHostFrame (#781) and MobileSplitShell (#779) can
 * react without coupling to the WS plumbing.
 *
 * Issue: https://github.com/hurttlocker/cortex-ide/issues/782
 *
 * Why a self-contained WS connection?
 *   The mobile split-shell shares its primary WebSocket via the existing
 *   `useWebSocket` hook in src/components/mobile/hooks/useWebSocket.ts.
 *   That hook is owned by a parallel agent and we cannot modify it from
 *   this slot, so this listener opens its own minimal connection just for
 *   the dev-host channel. The connection is cheap (one socket per device),
 *   auto-reconnects with exponential backoff, and never holds onto state.
 *
 * Contract for #781 (DevHostFrame) — listen for the window event:
 *
 *   window.addEventListener('o8:mobile-url-push', (event) => {
 *     const { url, sentAt, sourceRepoId } = (event as CustomEvent<{
 *       url: string;
 *       sentAt: string;
 *       sourceRepoId: string | null;
 *     }>).detail;
 *     // Re-point the dev-host iframe.
 *   });
 *
 * Contract for #779 (MobileSplitShell) — mount this listener inside a
 * useEffect on the landscape PWA route:
 *
 *   useEffect(() => attachMobileUrlPushListener({
 *     onUrlReady: (detail) => { setLatestUrl(detail.url); },
 *   }), []);
 */

import { useEffect } from 'react';
import { getBrowserWsPort } from '@/lib/panel/ws-port-client';
import { triggerHaptic } from '@/lib/mobile/haptic';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';

export const MOBILE_URL_PUSH_EVENT = 'o8:mobile-url-push' as const;

export interface MobileUrlPushDetail {
  url: string;
  sentAt: string;
  sourceRepoId: string | null;
}

interface AttachOptions {
  /**
   * Optional handler for in-component reactions (banners, haptics, state
   * sync). Called AFTER the global window event has been dispatched, so
   * any listener bound via addEventListener already received the payload.
   */
  onUrlReady?: (detail: MobileUrlPushDetail) => void;
  /**
   * When true (default), trigger a `success` haptic on receipt. Disable
   * for surfaces that already buzz from a different signal.
   */
  haptic?: boolean;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

function readWsToken(): string {
  return getMobileWsToken();
}

function buildWsUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const { hostname, protocol } = window.location;
  const wsProto = protocol === 'https:' ? 'wss' : 'ws';
  const token = readWsToken();
  if (!token) return null;
  return `${wsProto}://${hostname}:${getBrowserWsPort()}/ws?token=${encodeURIComponent(token)}`;
}

function isMobileUrlPushDetail(value: unknown): value is MobileUrlPushDetail {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.url === 'string' && typeof candidate.sentAt === 'string';
}

/**
 * Attach the listener imperatively. Returns a cleanup function. Safe to
 * call from any component that mounts on the landscape route.
 */
export function attachMobileUrlPushListener(options: AttachOptions = {}): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;
  let disposed = false;

  const dispatch = (detail: MobileUrlPushDetail) => {
    window.dispatchEvent(new CustomEvent<MobileUrlPushDetail>(MOBILE_URL_PUSH_EVENT, { detail }));
    if (options.haptic !== false) {
      try {
        triggerHaptic('success');
      } catch {
        // Haptic API can throw in unusual webviews — non-fatal.
      }
    }
    try {
      options.onUrlReady?.(detail);
    } catch (error) {
      console.warn('[mobile-url-push] onUrlReady handler threw', error);
    }
  };

  const handleMessage = (event: MessageEvent) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof event.data === 'string' ? event.data : '');
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const message = parsed as { channel?: unknown; event?: unknown; data?: unknown };
    if (message.channel !== 'mobile-dev-host' || message.event !== 'url-push') return;
    const data = message.data;
    if (!isMobileUrlPushDetail(data)) return;
    dispatch({
      url: data.url,
      sentAt: data.sentAt,
      sourceRepoId: data.sourceRepoId ?? null,
    });
  };

  const scheduleReconnect = () => {
    if (disposed) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoffMs);
    backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
  };

  const connect = () => {
    if (disposed) return;
    const url = buildWsUrl();
    if (!url) {
      scheduleReconnect();
      return;
    }
    try {
      socket = new WebSocket(url);
    } catch (error) {
      console.warn('[mobile-url-push] WebSocket open failed', error);
      scheduleReconnect();
      return;
    }
    socket.addEventListener('open', () => {
      backoffMs = INITIAL_BACKOFF_MS;
    });
    socket.addEventListener('message', handleMessage);
    socket.addEventListener('close', () => {
      socket = null;
      scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      // The close handler will fire next and trigger reconnection.
    });
  };

  connect();

  return () => {
    disposed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      try {
        socket.close();
      } catch {
        // Ignored — close failures are harmless once the page unmounts.
      }
      socket = null;
    }
  };
}

/**
 * React hook wrapper around `attachMobileUrlPushListener`. Mount once at
 * the landscape root inside MobileSplitShell so the dev-host iframe can
 * stay decoupled from WS plumbing.
 */
export function useMobileUrlPushListener(options: AttachOptions = {}): void {
  const { onUrlReady, haptic } = options;
  useEffect(() => {
    return attachMobileUrlPushListener({ onUrlReady, haptic });
  }, [onUrlReady, haptic]);
}
