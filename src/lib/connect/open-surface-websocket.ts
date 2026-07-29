import { isWebMachineBrowserSurface } from './web-machine-surface';

/**
 * Open the page's realtime channel through the machine bridge when this page
 * was relayed, otherwise preserve the caller's existing direct WebSocket URL.
 */
export function openSurfaceWebSocket(url: string): WebSocket | null {
  if (typeof window === 'undefined') return null;
  if (isWebMachineBrowserSurface()) {
    return window.__O8_WEB_MACHINE_TRANSPORT__?.openWebSocket('/ws') ?? null;
  }
  return url ? new WebSocket(url) : null;
}
