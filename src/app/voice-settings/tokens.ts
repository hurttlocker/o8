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
export type VsSurface = 'auto' | 'glass' | 'solid' | 'liquid';
export interface GlassControls { surface: VsSurface; frost: number; clarity: number; saturate: number }

// Picking a surface seeds the sliders; 'auto' resolves from o8's transparency.
export const SURFACE_PRESETS: Record<'glass' | 'solid' | 'liquid', { frost: number; clarity: number; saturate: number }> = {
  glass: { frost: 28, clarity: 60, saturate: 115 },
  solid: { frost: 0, clarity: 4, saturate: 100 },
  // Operator-tuned "fire" look: clear, no blur, max color pop + the specular sheen.
  liquid: { frost: 0, clarity: 100, saturate: 220 },
};
export const DEFAULT_GLASS: GlassControls = { surface: 'auto', frost: 28, clarity: 60, saturate: 115 };

/** Resolve the live glass params. 'auto' follows o8's transparency; any other
 * surface uses the live slider values (seeded from its preset when picked). */
export function resolveGlass(c: GlassControls, o8Transparent: boolean): { frost: number; clarity: number; saturate: number } {
  if (c.surface === 'auto') return o8Transparent ? SURFACE_PRESETS.glass : SURFACE_PRESETS.solid;
  return { frost: c.frost, clarity: c.clarity, saturate: c.saturate };
}

/** clarity 0..100 → scrim opacity (0 = solid panel, 100 = clearest glass). */
export function scrimOpacity(clarity: number): number {
  return Math.max(0.05, Math.min(0.99, 1 - (clarity / 100) * 0.95));
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
    '--vs-shell-border': 'rgba(255,255,255,0.90)',
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
