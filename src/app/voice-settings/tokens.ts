/**
 * Voice-settings design tokens — Symon's glass settings window, themed to follow
 * o8's palette (light / midnight). The surface + ink tokens resolve to CSS vars
 * (`--vs-*`) so components import stable names; page.tsx sets the actual values
 * on the shell root per the active o8 theme (read from localStorage
 * `cortex-theme-palette`). Accent / status / traffic-light / wave are
 * theme-independent literals. Inline styles only; icons live in ./icons.tsx.
 */

// ── Type / motion ── (hurttlocker: system stack, weight 300 chrome, never 600+)
export const SF = 'var(--font-sans-system)';
export const W_BODY = 300;
export const W_HEADING = 400;
export const W_STRONG = 500;
export const TRANS = '180ms ease';
export const TRANS_FAST = '150ms cubic-bezier(0.25,0.1,0.25,1)';

// ── Ink (themed) ──
export const TEXT_PRIMARY = 'var(--vs-text-primary)';
export const TEXT_SECONDARY = 'var(--vs-text-secondary)';
export const TEXT_TERTIARY = 'var(--vs-text-tertiary)';

// ── Accent (theme-independent o8 voice blue) ──
export const ACCENT = '#4058FF';
export const ACCENT_LIGHT = '#6B7FFF';
export const ACCENT_GLOW = 'rgba(64,88,255,0.45)';
export const ACCENT_GLOW_SOFT = 'rgba(64,88,255,0.28)';

// ── Glass surfaces (themed) ──
export const GLASS_BG = 'var(--vs-glass-bg)';
export const GLASS_BG_HOVER = 'var(--vs-glass-bg-hover)';
export const GLASS_BG_ACTIVE = 'var(--vs-glass-bg-active)';
export const GLASS_BORDER = 'var(--vs-glass-border)';
export const GLASS_BORDER_SUBTLE = 'var(--vs-glass-border-subtle)';

// ── Shell / chrome (themed) ──
export const SHELL_BG = 'var(--vs-shell-bg)';
export const SHELL_BORDER = 'var(--vs-shell-border)';
export const SHELL_SHADOW = 'var(--vs-shell-shadow)';
export const FROST_BASE = 'var(--vs-frost-base)';
export const SIDEBAR_BG = 'var(--vs-sidebar-bg)';
export const CONTENT_BG = 'var(--vs-content-bg)';
export const GRID_DOT = 'var(--vs-grid-dot)';
export const NAV_HOVER = 'var(--vs-nav-hover)';
export const NAV_ACTIVE = 'var(--vs-nav-active)';
export const NAV_BORDER = 'var(--vs-nav-border)';
export const SECTION_BG = 'var(--vs-section-bg)';
export const SECTION_BORDER = 'var(--vs-section-border)';
export const SECTION_SHADOW = 'var(--vs-section-shadow)';

// ── Status colors (theme-independent) ──
export const OK_GREEN = '#34D399';
export const WARN_AMBER = '#F59E0B';
export const DANGER_RED = '#F87171';

// ── Traffic lights ──
export const TL_CLOSE = '#FF5F57';
export const TL_CLOSE_HOVER = '#FF3B30';
export const TL_MIN = '#FFBD2E';
export const TL_ZOOM = '#28CA41';

// ── Brand wave gradient stops ──
export const WAVE_STOPS = ['#88D1F1', '#B1B4E5', '#F5B8C4', '#F4C977'] as const;

// Re-export the Iconoir icon map so `import { ICONS } from '../tokens'` keeps working.
export { ICONS } from './icons';

// ── Adjustable glass (Theme tab) ── frost = backdrop blur; clarity = how
// see-through (drives a scrim opacity); saturate = backdrop saturation. A high
// saturation flips on the "liquid" specular sheen (Apple Liquid Glass cue).
export type VsSurface = 'auto' | 'glass' | 'solid';
// Ink override (Theme tab) — Light reads when the glass is pushed fully clear;
// Auto follows the o8 palette.
export type VsText = 'auto' | 'light' | 'dark';
// frost = backdrop blur; clarity = see-through (scrim opacity); saturate =
// backdrop saturation; brightness = material lift (%); lighting = specular gloss
// + bright edges (light playing on the surface, 0 = flat); diffusion = milky
// light-scattering (frosted softness, 0 = clear). All 0 → today's exact glass.
export interface GlassControls {
  surface: VsSurface;
  frost: number;
  clarity: number;
  saturate: number;
  brightness: number;
  lighting: number;
  diffusion: number;
  text: VsText;
  // When true (+ high clarity), the sidebar and the section cards go clear too,
  // not just the in-between — the full all-clear look for white-on-glass.
  clearPanels: boolean;
}

// `text` + `clearPanels` are modes, not glass numbers — kept out of resolved params.
type GlassParams = Omit<GlassControls, 'surface' | 'text' | 'clearPanels'>;

// The locked "glass" tune (operator-finalized). Only Frost stays adjustable —
// it's the accessibility lever (more frost = more readable for low-vision users);
// the rest of the glass is fixed here so "glass" always means this exact look.
const GLASS_TUNE = { clarity: 200, saturate: 220, brightness: 135, lighting: 0, diffusion: 0 };

// Picking a surface seeds the look; 'auto' resolves from o8's transparency. Glass
// is the locked tune (frost 0 default); Solid is the opaque accessibility look.
export const SURFACE_PRESETS: Record<'glass' | 'solid', GlassParams> = {
  glass: { frost: 0, ...GLASS_TUNE },
  solid: { frost: 0, clarity: 4, saturate: 100, brightness: 100, lighting: 0, diffusion: 0 },
};
export const DEFAULT_GLASS: GlassControls = {
  surface: 'auto', frost: 0, ...GLASS_TUNE, text: 'auto', clearPanels: false,
};

/** Resolve the live glass params. 'auto' follows o8's transparency; any other
 * surface uses the live slider values (seeded from its preset when picked).
 * `?? default` keeps older persisted JSON safe across param renames. */
export function resolveGlass(c: GlassControls, o8Transparent: boolean): GlassParams {
  if (c.surface === 'auto') return o8Transparent ? SURFACE_PRESETS.glass : SURFACE_PRESETS.solid;
  // The tune is locked — only Frost varies. Force the preset values for
  // everything else so stale persisted experiments can't change the look.
  const preset = c.surface === 'solid' ? SURFACE_PRESETS.solid : SURFACE_PRESETS.glass;
  return { ...preset, frost: c.frost };
}

/** clarity → scrim opacity (0 = solid panel; higher = clearer glass). 0..100 is
 * the original curve (1 → 0.05); 100..200 pushes the last sliver of tint away
 * (0.05 → 0) so you can fine-tune all the way to fully-clear, dock-style glass. */
export function scrimOpacity(clarity: number): number {
  if (clarity <= 100) return Math.max(0.05, Math.min(0.99, 1 - (clarity / 100) * 0.95));
  return Math.max(0, 0.05 - ((clarity - 100) / 100) * 0.05);
}

// ── Theme var maps ── applied to the shell root by page.tsx. Light = Symon's
// "frost" surface (dark ink on white glass); dark = the midnight glass.
export type VsMode = 'light' | 'dark';

export const VS_THEME_VARS: Record<VsMode, Record<string, string>> = {
  dark: {
    '--vs-text-primary': 'rgba(255,255,255,0.95)',
    '--vs-text-secondary': 'rgba(255,255,255,0.60)',
    '--vs-text-tertiary': 'rgba(255,255,255,0.40)',
    '--vs-glass-bg': 'rgba(255,255,255,0.06)',
    '--vs-glass-bg-hover': 'rgba(255,255,255,0.10)',
    '--vs-glass-bg-active': 'rgba(255,255,255,0.14)',
    '--vs-glass-border': 'rgba(255,255,255,0.14)',
    '--vs-glass-border-subtle': 'rgba(255,255,255,0.08)',
    '--vs-shell-bg': 'linear-gradient(180deg, rgba(12,18,30,0.44), rgba(9,14,24,0.34))',
    '--vs-shell-border': 'rgba(255,255,255,0.14)',
    '--vs-shell-shadow': '0 24px 60px rgba(2,6,23,0.40)',
    '--vs-frost-base': 'linear-gradient(180deg, rgba(10,16,26,0.18), rgba(9,14,24,0.12))',
    '--vs-sidebar-bg': 'linear-gradient(180deg, rgba(255,255,255,0.09), rgba(255,255,255,0.04))',
    '--vs-content-bg': 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02))',
    '--vs-grid-dot': 'rgba(255,255,255,0.08)',
    '--vs-nav-hover': 'rgba(255,255,255,0.09)',
    '--vs-nav-active': 'rgba(255,255,255,0.14)',
    '--vs-nav-border': 'rgba(255,255,255,0.10)',
    '--vs-section-bg': 'linear-gradient(180deg, rgba(255,255,255,0.065), rgba(255,255,255,0.025))',
    '--vs-section-border': 'rgba(255,255,255,0.08)',
    '--vs-section-shadow': '0 18px 36px rgba(2,6,23,0.16)',
    '--vs-accent-radial': 'rgba(64,88,255,0.20)',
    '--vs-scrim-rgb': '11,16,26',
  },
  light: {
    '--vs-text-primary': 'rgba(15,23,42,0.92)',
    '--vs-text-secondary': 'rgba(30,41,59,0.62)',
    '--vs-text-tertiary': 'rgba(51,65,85,0.50)',
    '--vs-glass-bg': 'rgba(255,255,255,0.70)',
    '--vs-glass-bg-hover': 'rgba(255,255,255,0.88)',
    '--vs-glass-bg-active': 'rgba(255,255,255,0.96)',
    '--vs-glass-border': 'rgba(15,23,42,0.14)',
    '--vs-glass-border-subtle': 'rgba(15,23,42,0.09)',
    // Opaque enough to read crisp-light over the (dark) HudWindow material.
    '--vs-shell-bg': 'linear-gradient(180deg, rgba(248,250,253,0.94), rgba(241,245,250,0.88))',
    // Softer than pure white — a 0.90 white bezel reads stark/distracting against
    // the now-clear glass. Soft neutral edge; the drop shadow carries definition.
    '--vs-shell-border': 'rgba(226,232,240,0.55)',
    '--vs-shell-shadow': '0 24px 60px rgba(100,116,139,0.26)',
    '--vs-frost-base': 'linear-gradient(180deg, rgba(255,255,255,0.62), rgba(248,250,253,0.50))',
    '--vs-sidebar-bg': 'linear-gradient(180deg, rgba(255,255,255,0.82), rgba(244,247,251,0.66))',
    '--vs-content-bg': 'linear-gradient(180deg, rgba(255,255,255,0.58), rgba(248,250,253,0.42))',
    '--vs-grid-dot': 'rgba(15,23,42,0.09)',
    '--vs-nav-hover': 'rgba(255,255,255,0.86)',
    '--vs-nav-active': 'rgba(255,255,255,0.98)',
    '--vs-nav-border': 'rgba(15,23,42,0.09)',
    '--vs-section-bg': 'linear-gradient(180deg, rgba(255,255,255,0.86), rgba(248,250,253,0.70))',
    '--vs-section-border': 'rgba(15,23,42,0.08)',
    '--vs-section-shadow': '0 14px 34px rgba(100,116,139,0.18)',
    '--vs-accent-radial': 'rgba(64,88,255,0.12)',
    '--vs-scrim-rgb': '248,250,253',
  },
};
