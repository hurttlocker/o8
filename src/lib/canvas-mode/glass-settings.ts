'use client';

/**
 * canvas-mode/glass-settings — operator-tunable glass material for Canvas
 * mode (#1232). Three knobs, persisted client-side and applied as CSS vars
 * so the Settings sliders and the /preview/canvas-glass test page share one
 * live value:
 *
 *   frost — backdrop blur radius (px). How much the world behind diffuses.
 *   tint  — dark tint alpha. 0 = clear glass, higher = the darker Apple/Siri
 *           material from the reference shots.
 *   ink   — text/icon white alpha. Legibility against whatever bleeds through.
 *
 * Vars (read them, never hardcode the material):
 *   --cnv-frost      blur(px) value, e.g. "26px"
 *   --cnv-tint       rgba surface tint
 *   --cnv-tint-deep  slightly darker tint for docks/inputs that need a step
 *   --cnv-ink        primary ink
 *   --cnv-ink-muted  secondary ink
 *   --cnv-edge       1px hairline for glass edges
 */

export interface CanvasGlassSettings {
  frost: number;
  tint: number;
  ink: number;
}

export const CANVAS_GLASS_DEFAULTS: CanvasGlassSettings = {
  frost: 26,
  tint: 0.42,
  ink: 0.92,
};

export const CANVAS_GLASS_RANGES = {
  frost: { min: 0, max: 64, step: 1 },
  tint: { min: 0, max: 0.85, step: 0.01 },
  ink: { min: 0.55, max: 1, step: 0.01 },
} as const;

const STORAGE_KEY = 'o8:canvas-glass';
export const CANVAS_GLASS_CHANGED_EVENT = 'o8:canvas-glass-changed';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function readCanvasGlassSettings(): CanvasGlassSettings {
  if (typeof window === 'undefined') return { ...CANVAS_GLASS_DEFAULTS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...CANVAS_GLASS_DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...CANVAS_GLASS_DEFAULTS };
    const candidate = parsed as Partial<CanvasGlassSettings>;
    return {
      frost: typeof candidate.frost === 'number' && Number.isFinite(candidate.frost)
        ? clamp(candidate.frost, CANVAS_GLASS_RANGES.frost.min, CANVAS_GLASS_RANGES.frost.max)
        : CANVAS_GLASS_DEFAULTS.frost,
      tint: typeof candidate.tint === 'number' && Number.isFinite(candidate.tint)
        ? clamp(candidate.tint, CANVAS_GLASS_RANGES.tint.min, CANVAS_GLASS_RANGES.tint.max)
        : CANVAS_GLASS_DEFAULTS.tint,
      ink: typeof candidate.ink === 'number' && Number.isFinite(candidate.ink)
        ? clamp(candidate.ink, CANVAS_GLASS_RANGES.ink.min, CANVAS_GLASS_RANGES.ink.max)
        : CANVAS_GLASS_DEFAULTS.ink,
    };
  } catch {
    return { ...CANVAS_GLASS_DEFAULTS };
  }
}

export function writeCanvasGlassSettings(settings: CanvasGlassSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // non-critical — the look just won't survive reload
  }
  applyCanvasGlassSettings(settings);
  window.dispatchEvent(new CustomEvent(CANVAS_GLASS_CHANGED_EVENT, { detail: settings }));
}

/** Stamp the material onto :root so any surface can consume it. */
export function applyCanvasGlassSettings(settings?: CanvasGlassSettings): void {
  if (typeof document === 'undefined') return;
  const value = settings ?? readCanvasGlassSettings();
  const root = document.documentElement;
  root.style.setProperty('--cnv-frost', `${Math.round(value.frost)}px`);
  // The tint tone is the Siri-reference near-black slate; only alpha is tunable.
  root.style.setProperty('--cnv-tint', `rgba(9, 11, 16, ${value.tint.toFixed(2)})`);
  root.style.setProperty('--cnv-tint-deep', `rgba(7, 9, 13, ${Math.min(0.92, value.tint + 0.16).toFixed(2)})`);
  root.style.setProperty('--cnv-ink', `rgba(255, 255, 255, ${value.ink.toFixed(2)})`);
  root.style.setProperty('--cnv-ink-muted', `rgba(255, 255, 255, ${(value.ink * 0.62).toFixed(2)})`);
  root.style.setProperty('--cnv-edge', `rgba(255, 255, 255, ${(0.1 + value.tint * 0.1).toFixed(2)})`);
}
