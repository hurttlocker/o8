import { O8_CLIENT_ADDR_HEADER } from '@/lib/auth/loopback-request';

export const O8_RELAY_FORWARD_HEADER = 'x-o8-relay-forward';
export const O8_RELAY_FORWARD_MARKER = 'o8-relay-forward';
export const O8_RELAY_SURFACE_HEADER = 'x-o8-relay-surface';
export const O8_WEB_MACHINE_SURFACE = 'web-machine';
export const O8_AUTH_MODE_META = 'o8-auth-mode';

/**
 * A web-machine request must carry all three server-derived relay facts. The
 * packaged HTTP wrapper canonicalizes these headers from the loopback relay
 * connector, so a remote client cannot turn itself into a trusted local page.
 */
export function headersIndicateWebMachineRelay(
  get: (name: string) => string | null,
): boolean {
  return get(O8_CLIENT_ADDR_HEADER) === O8_RELAY_FORWARD_MARKER
    && get(O8_RELAY_FORWARD_HEADER) === '1'
    && get(O8_RELAY_SURFACE_HEADER) === O8_WEB_MACHINE_SURFACE;
}

export interface WebMachineBrowserTransport {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  openWebSocket: (path: '/ws') => WebSocket;
}

declare global {
  interface Window {
    __O8_WEB_MACHINE_TRANSPORT__?: WebMachineBrowserTransport;
  }
}

export function isWebMachineBrowserSurface(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector(`meta[name="${O8_AUTH_MODE_META}"]`)
    ?.getAttribute('content') === O8_WEB_MACHINE_SURFACE;
}
