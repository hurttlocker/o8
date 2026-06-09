/**
 * Voice-settings design tokens — Symon's glass settings window, dark "midnight"
 * tone. Literal rgba (no var(--t-*)): this route renders inside the standalone
 * transparent `voice-settings` Tauri window, which has no o8 ThemeProvider above
 * it. Values ported verbatim from aqua-color's settingsSurfaceStyle() dark map.
 *
 * Inline styles only. Icons live in ./icons.tsx (Iconoir, per hurttlocker).
 */

// ── Type / motion ──
// o8's locked system stack (hurttlocker). Never a webfont, never hardcoded SF —
// var(--font-sans-system) renders 300 as a true thin on macOS. Weight discipline:
// body/labels/nav/buttons 300, badges ≤500, headings 400. Never 600+ on chrome.
export const SF = 'var(--font-sans-system)';
export const W_BODY = 300;
export const W_HEADING = 400;
export const W_STRONG = 500;
export const TRANS = '180ms ease';
export const TRANS_FAST = '150ms cubic-bezier(0.25,0.1,0.25,1)';

// ── Ink ──
export const TEXT_PRIMARY = 'rgba(255,255,255,0.95)';
export const TEXT_SECONDARY = 'rgba(255,255,255,0.60)';
export const TEXT_TERTIARY = 'rgba(255,255,255,0.40)';

// ── Accent (o8 voice blue) ──
export const ACCENT = '#4058FF';
export const ACCENT_LIGHT = '#6B7FFF';
export const ACCENT_GLOW = 'rgba(64,88,255,0.45)';
export const ACCENT_GLOW_SOFT = 'rgba(64,88,255,0.28)';

// ── Glass surfaces (dark) ──
export const GLASS_BG = 'rgba(255,255,255,0.06)';
export const GLASS_BG_HOVER = 'rgba(255,255,255,0.10)';
export const GLASS_BG_ACTIVE = 'rgba(255,255,255,0.14)';
export const GLASS_BORDER = 'rgba(255,255,255,0.14)';
export const GLASS_BORDER_SUBTLE = 'rgba(255,255,255,0.08)';

// ── Shell / chrome (dark) ── lighter than Symon's 0.88 so the macOS vibrancy
// material (applied Rust-side) reads through as frosted glass, not a flat panel.
export const SHELL_BG =
  'linear-gradient(180deg, rgba(10,16,26,0.62), rgba(9,14,24,0.50))';
export const SHELL_BORDER = 'rgba(255,255,255,0.12)';
export const SHELL_SHADOW = '0 24px 60px rgba(2,6,23,0.34)';
export const FROST_BASE =
  'linear-gradient(180deg, rgba(10,16,26,0.34), rgba(9,14,24,0.26))';
export const SIDEBAR_BG =
  'linear-gradient(180deg, rgba(255,255,255,0.09), rgba(255,255,255,0.04))';
export const CONTENT_BG =
  'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02))';
export const GRID_DOT = 'rgba(255,255,255,0.08)';
export const NAV_HOVER = 'rgba(255,255,255,0.09)';
export const NAV_ACTIVE = 'rgba(255,255,255,0.14)';
export const NAV_BORDER = 'rgba(255,255,255,0.10)';
export const SECTION_BG =
  'linear-gradient(180deg, rgba(255,255,255,0.065), rgba(255,255,255,0.025))';
export const SECTION_BORDER = 'rgba(255,255,255,0.08)';
export const SECTION_SHADOW = '0 18px 36px rgba(2,6,23,0.16)';

// ── Status colors ──
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

// Re-export the Iconoir icon map so existing `import { ICONS } from '../tokens'`
// callers keep working. Definitions live in ./icons.tsx.
export { ICONS } from './icons';

