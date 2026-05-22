/**
 * Open an external URL from the desktop app.
 *
 * `window.open` is a no-op inside the Tauri webview (confirmed: it returns null
 * and never navigates), so anything wired to `window.open(url, '_blank')`
 * silently does nothing in the packaged app. Use the shell plugin when running
 * in Tauri and fall back to `window.open` in the browser (dev / web preview).
 *
 * Returns void (fires the async work internally) so call sites stay simple and
 * don't trip floating-promise / misused-promise lint in JSX event handlers.
 */
export function openExternalUrl(url: string | null | undefined): void {
  if (!url) return;
  if (typeof window === 'undefined') return;
  if ('__TAURI_INTERNALS__' in window) {
    void import('@tauri-apps/plugin-shell')
      .then(({ open }) => open(url))
      .catch(() => { window.open(url, '_blank', 'noopener,noreferrer'); });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
