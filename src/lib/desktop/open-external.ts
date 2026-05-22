/**
 * Open an external URL from the desktop app.
 *
 * `window.open` is a no-op inside the Tauri webview (confirmed: it returns null
 * and never navigates), so anything wired to `window.open(url, '_blank')`
 * silently does nothing in the packaged app. Use the shell plugin when running
 * in Tauri and fall back to `window.open` in the browser (dev / web preview).
 */
export async function openExternalUrl(url: string | null | undefined): Promise<void> {
  if (!url) return;
  if (typeof window === 'undefined') return;
  try {
    if ('__TAURI_INTERNALS__' in window) {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
      return;
    }
  } catch {
    // Shell plugin unavailable — fall through to the browser path.
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
