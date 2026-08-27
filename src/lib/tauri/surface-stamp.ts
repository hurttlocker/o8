/**
 * The native runtime can finish installing its window globals after the root
 * layout's body script runs. Keep probing briefly so every packaged route,
 * including routes that do not mount ThemeProvider, receives the transparent
 * surface stamp once the runtime is ready.
 */
export const TAURI_SURFACE_STAMP = `
  (function stampTauriSurface(attempt) {
    try {
      if (window.__TAURI_INTERNALS__) {
        var root = document.documentElement;
        var body = document.body;
        root.dataset.tauri = 'true';
        if (body) body.dataset.tauri = 'true';
        root.style.background = '';
        if (body) body.style.background = '';
        return;
      }
      if (attempt < 120 && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(function () {
          stampTauriSurface(attempt + 1);
        });
      }
    } catch (e) {}
  })(0);
`;
