'use client';

/**
 * Client-side ws-token resolution for the mobile surface.
 *
 * The token reaches the mobile client one of three ways, checked in order:
 *
 * 1. `#tk=<token>` URL fragment — the pairing link rendered by the desktop
 *    MobilePairingView. Fragments never leave the browser (not sent to the
 *    server, not logged), so this is the LAN-safe delivery path. Captured
 *    once into localStorage, then scrubbed from the visible URL.
 * 2. `<meta name="ws-token">` — embedded by the server ONLY for loopback
 *    page loads (desktop webview, dev). LAN page loads get no meta token.
 * 3. localStorage — persisted from an earlier pairing.
 */

const STORAGE_KEY = 'o8:mobile-ws-token';

function captureHashToken(): string | null {
  try {
    const hash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);
    const token = params.get('tk');
    if (!token) return null;
    try {
      window.localStorage.setItem(STORAGE_KEY, token);
    } catch {
      // Private-mode storage failure — token still usable for this page load.
    }
    // Scrub the credential from the visible URL / history entry.
    params.delete('tk');
    const remainingHash = params.toString();
    const cleanedHash = remainingHash ? `#${remainingHash}` : '';
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search + cleanedHash,
    );
    return token;
  } catch {
    return null;
  }
}

export function getMobileWsToken(): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return '';
  const fromHash = captureHashToken();
  if (fromHash) return fromHash;
  const fromMeta = document.querySelector('meta[name="ws-token"]')?.getAttribute('content');
  if (fromMeta) return fromMeta;
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}
