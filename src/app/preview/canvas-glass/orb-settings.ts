'use client';

/**
 * orb-settings — operator-tunable refraction dials for the NavigatorLoupe
 * crystal ball (#1239). Each field maps to a shader uniform in
 * `refraction-ball.tsx`, so a slider in the orb tuner drives the WebGL look
 * live — no code edits, no reload. Persisted per canvas tone (light/dark)
 * because the glass reads differently against a light vs dark backdrop, so the
 * operator dials each and we save both.
 */

export interface OrbSettings {
  /** Centre magnification — how much the lens swells the content (u_refract). */
  magnify: number;
  /** Rim wrap — hemisphere curvature: how hard cards foreshorten + shrink as
   *  they near the rim (the real sphere "wrap", not overall zoom). Higher =
   *  stronger wrap, cards near the edge get much smaller and curl. */
  wrap: number;
  /** Edge — how far the content spreads toward the rim (overall fill / size).
   *  Lower = smaller cards with a wider clear-glass margin; higher = content
   *  reaches closer to the edge. */
  edge: number;
  /** Chromatic aberration — radial R/G/B split through the glass (u_aberr). */
  chroma: number;
  /** Specular hotspot intensity (upper-left glare). */
  specular: number;
  /** Rim fringe — the rainbow chromatic ring at the very edge. */
  rim: number;
  /** Depth — volumetric vignette that darkens toward the rim (3D form). */
  depth: number;
  /** Fog — glass cloudiness. Low = clear/liquid (sharp content), high = frosted. */
  fog: number;
  /** Glass — body luminosity. Low = deep clear glass, high = bright milky glass. */
  glass: number;
}

export type CanvasTone = 'light' | 'dark';

/** Defaults = the operator's tuned orb, shipped for EVERYONE on every page +
 *  theme (the orb is universal, not part of a glass theme). A deep, milky
 *  sphere: max edge-fill + depth + glass body, full chroma, and NO specular
 *  hotspot or rim glow (the operator's locked look, 2026-06-15). */
export const ORB_DEFAULTS: OrbSettings = {
  magnify: 0,
  wrap: 1.6,
  edge: 1,
  chroma: 0.08,
  specular: 0,
  rim: 0,
  depth: 1.4,
  fog: 0,
  glass: 1,
};

export const ORB_RANGES: Record<keyof OrbSettings, { min: number; max: number; step: number }> = {
  magnify: { min: 0, max: 0.6, step: 0.01 },
  wrap: { min: 0, max: 3, step: 0.02 },
  edge: { min: 0, max: 1, step: 0.01 },
  chroma: { min: 0, max: 0.08, step: 0.001 },
  specular: { min: 0, max: 2, step: 0.02 },
  rim: { min: 0, max: 1, step: 0.01 },
  depth: { min: 0, max: 1.4, step: 0.02 },
  fog: { min: 0, max: 1, step: 0.01 },
  glass: { min: 0, max: 1, step: 0.01 },
};

/** Slider rows, in display order. */
export const ORB_DIALS: ReadonlyArray<{ key: keyof OrbSettings; label: string }> = [
  { key: 'fog', label: 'Fog' },
  { key: 'glass', label: 'Glass' },
  { key: 'edge', label: 'Edge' },
  { key: 'magnify', label: 'Magnify' },
  { key: 'wrap', label: 'Rim wrap' },
  { key: 'chroma', label: 'Chroma' },
  { key: 'specular', label: 'Specular' },
  { key: 'rim', label: 'Rim glow' },
  { key: 'depth', label: 'Depth' },
];

// Bumped to v2 for the sphere-projection rewrite — the old fragment-lens dial
// values map to a different look under the geometry projection, so don't load them.
const STORAGE_KEY = 'o8:orb-refraction-v2';

function clampSettings(raw: Partial<OrbSettings> | null | undefined): OrbSettings {
  const merged = { ...ORB_DEFAULTS, ...(raw ?? {}) };
  for (const key of Object.keys(ORB_DEFAULTS) as Array<keyof OrbSettings>) {
    const { min, max } = ORB_RANGES[key];
    const v = Number(merged[key]);
    merged[key] = Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : ORB_DEFAULTS[key];
  }
  return merged;
}

type Store = Partial<Record<CanvasTone, OrbSettings>>;

function readStore(): Store {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

/** The operator's saved dials for a tone, or the defaults if never tuned. */
export function readOrbSettings(tone: CanvasTone): OrbSettings {
  return clampSettings(readStore()[tone]);
}

export function writeOrbSettings(tone: CanvasTone, settings: OrbSettings): void {
  if (typeof window === 'undefined') return;
  try {
    const store = readStore();
    store[tone] = clampSettings(settings);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* private mode / quota — live state still drives the orb this session. */
  }
}
