/**
 * Global UI zoom for the o8 IDE shell — the native ⌘- / ⌘= / ⌘+ / ⌘0 affordance
 * developers expect ("make everything bigger / smaller"). One clamped, persisted
 * zoom level applied as CSS `zoom` on <html>, so the entire IDE — chrome, panels,
 * portals, dialogs — scales together exactly like browser / VSCode zoom.
 *
 * Scope: the IDE only. The canvas surface (`/preview/canvas-glass`) owns its own
 * field-of-view control + pointer math, so the layer that drives this resets the
 * applied zoom on unmount (see UiZoomLayer) and it never bleeds across routes.
 *
 * CSS `zoom` (not `transform: scale`) is deliberate — it reflows layout, keeps
 * scrolling, fixed-position overlays and hit-testing correct, and matches how
 * native browser zoom behaves. `transform: scale` would leave gaps and break
 * fixed positioning / hit-targets.
 */

export const UI_ZOOM_KEY = 'o8:ui-zoom';

// Apple / Chrome-style preset ladder. 1.0 is "actual size" — the ⌘0 reset target.
export const UI_ZOOM_STEPS: readonly number[] = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0,
];

export const UI_ZOOM_DEFAULT = 1.0;
export const UI_ZOOM_MIN = UI_ZOOM_STEPS[0];
export const UI_ZOOM_MAX = UI_ZOOM_STEPS[UI_ZOOM_STEPS.length - 1];

export function clampUiZoom(level: number): number {
  if (!Number.isFinite(level)) return UI_ZOOM_DEFAULT;
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, level));
}

// Snap an arbitrary level to the nearest preset so persisted / stepped values
// always sit on the ladder (and so ⌘+/- step predictably from any start point).
function snapToStep(level: number): number {
  let nearest: number = UI_ZOOM_STEPS[0];
  let bestGap = Math.abs(level - nearest);
  for (const step of UI_ZOOM_STEPS) {
    const gap = Math.abs(level - step);
    if (gap < bestGap) {
      bestGap = gap;
      nearest = step;
    }
  }
  return nearest;
}

// Step through the preset ladder. dir > 0 zooms IN, dir < 0 zooms OUT. Clamped.
export function stepUiZoom(current: number, dir: number): number {
  const idx = UI_ZOOM_STEPS.indexOf(snapToStep(current));
  const nextIdx = Math.min(
    UI_ZOOM_STEPS.length - 1,
    Math.max(0, idx + (dir > 0 ? 1 : -1)),
  );
  return UI_ZOOM_STEPS[nextIdx];
}

export function readStoredUiZoom(): number {
  if (typeof window === 'undefined') return UI_ZOOM_DEFAULT;
  try {
    const raw = window.localStorage.getItem(UI_ZOOM_KEY);
    if (!raw) return UI_ZOOM_DEFAULT;
    return clampUiZoom(Number.parseFloat(raw));
  } catch {
    return UI_ZOOM_DEFAULT;
  }
}

export function persistUiZoom(level: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(UI_ZOOM_KEY, String(level));
  } catch {
    /* localStorage unavailable (private mode / quota) — zoom still applies for the session */
  }
}

// Apply the zoom to the document root via setProperty (avoids relying on the
// `zoom` typing in CSSStyleDeclaration) plus mirror it into a `--ui-zoom` var so
// any consumer can read the live value.
export function applyUiZoom(level: number): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('zoom', String(level));
  root.style.setProperty('--ui-zoom', String(level));
}

// Drop the inline zoom override (used on IDE unmount so the IDE zoom never leaks
// into the canvas route's own zoom system).
export function clearUiZoom(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.removeProperty('zoom');
  root.style.setProperty('--ui-zoom', '1');
}

export function formatUiZoomPercent(level: number): string {
  return `${Math.round(level * 100)}%`;
}
