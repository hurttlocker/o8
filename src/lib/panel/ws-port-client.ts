/**
 * Browser-side WS port resolver.
 *
 * The Tauri Rust sidecar probes a free port for the ws-server and writes it
 * to `~/.cortex-ide/ws-port`. The root layout (`src/app/layout.tsx`) reads
 * that file server-side and injects the value as `window.__O8_WS_PORT__`
 * before any client code runs.
 *
 * Browser hooks call `getBrowserWsPort()` instead of hardcoding 3002. Legacy
 * dev workflows (`npm run dev` without Tauri) fall back to the default 3002,
 * which matches the port ws-server binds to when no override is set.
 */

const DEFAULT_WS_PORT = 3002;

declare global {
  interface Window {
    __O8_WS_PORT__?: number;
  }
}

export function getBrowserWsPort(): number {
  if (typeof window === 'undefined') return DEFAULT_WS_PORT;
  const injected = window.__O8_WS_PORT__;
  if (typeof injected === 'number' && Number.isInteger(injected) && injected > 0 && injected < 65536) {
    return injected;
  }
  return DEFAULT_WS_PORT;
}
