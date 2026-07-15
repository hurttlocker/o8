/**
 * Theme registry — typed, two-axis (palette × surface).
 *
 * - **Palette**: `light` | `dark` — color family. User-facing in the picker.
 * - **Surface**: `glass` | `solid` — chrome layer behavior. Driven by the
 *   "Reduce transparency" toggle (matches macOS accessibility wording).
 *
 * Adding a new palette = one entry in PALETTES with three token blocks
 * (base, glass, solid). Adding a new surface mode = extend SurfaceMode +
 * a branch in resolveTheme.
 *
 * Solid-mode rationale: blur and translucency cause real accessibility
 * problems — low vision, motion sensitivity, vestibular disorders. Solid
 * mode pins all chrome tokens to fully opaque values so the vibrancy
 * underneath has nothing to bleed through. The Tauri vibrancy layer is
 * still on (we just paint over it), saving a Rust IPC round-trip on
 * theme change. A future Phase 2 will add a `set_window_vibrancy` IPC
 * that disables the macOS material entirely in solid mode for GPU savings.
 */

export type SurfaceMode = 'glass' | 'solid';
export type PaletteId = 'light' | 'dark';

export interface ThemePreview {
  bg: string;
  panel: string;
  nav: string;
  titlebar: string;
  accent: string;
  text: string;
  textMuted: string;
}

export interface ThemePalette {
  id: PaletteId;
  name: string;
  colorScheme: 'light' | 'dark';
  /** Founders-only palette — hidden from the free picker (#1450). The core
   * light/dark pair ("the o8 theme") stays free; extra themes ship founders-first. */
  foundersOnly?: boolean;
  /** Hint shown in the picker preview for each surface mode. */
  preview: ThemePreview;
  /** Tokens that don't change with surface mode. */
  baseTokens: Record<string, string>;
  /** Tokens applied in glass surface mode (rgba over OS vibrancy). */
  glassTokens: Record<string, string>;
  /** Tokens applied in solid surface mode (fully opaque chrome). */
  solidTokens: Record<string, string>;
}

export interface ResolvedTheme {
  paletteId: PaletteId;
  surface: SurfaceMode;
  /** Composed `${paletteId}-${surface}` — used in localStorage and data-theme attr. */
  id: string;
  name: string;
  colorScheme: 'light' | 'dark';
  preview: ThemePreview;
  cssVars: Record<string, string>;
}

export function resolveTheme(palette: ThemePalette, surface: SurfaceMode): ResolvedTheme {
  const cssVars =
    surface === 'solid'
      ? { ...palette.baseTokens, ...palette.solidTokens }
      : { ...palette.baseTokens, ...palette.glassTokens };
  return {
    paletteId: palette.id,
    surface,
    id: `${palette.id}-${surface}`,
    name: palette.name,
    colorScheme: palette.colorScheme,
    preview: palette.preview,
    cssVars,
  };
}

// ── Light palette ────────────────────────────────────────────────────────────

const LIGHT_BASE: Record<string, string> = {
  // Text
  '--t-text': '#0f172a',
  '--t-text-strong': '#020617',
  '--t-text-secondary': '#475569',
  '--t-text-muted': '#64748b',
  '--t-text-faint': '#94a3b8',
  // Accent
  '--t-accent': '#2563eb',
  '--t-accent-soft': 'rgba(37, 99, 235, 0.1)',
  '--t-accent-soft-strong': 'rgba(37, 99, 235, 0.18)',
  '--t-accent-border': 'rgba(37, 99, 235, 0.26)',
  '--t-accent-ring': 'rgba(37, 99, 235, 0.16)',
  // Semantic status tones
  '--t-success': '#16a34a',
  '--t-success-soft': 'rgba(22, 163, 74, 0.1)',
  '--t-success-border': 'rgba(22, 163, 74, 0.22)',
  '--t-success-contrast': '#ffffff',
  '--t-warning': '#f97316',
  '--t-warning-soft': 'rgba(249, 115, 22, 0.11)',
  '--t-warning-border': 'rgba(249, 115, 22, 0.22)',
  '--t-warning-contrast': '#ffffff',
  '--t-danger': '#ef4444',
  '--t-danger-soft': 'rgba(239, 68, 68, 0.1)',
  '--t-danger-border': 'rgba(239, 68, 68, 0.22)',
  '--t-danger-contrast': '#ffffff',
  // Muted tones for dense status bar controls.
  '--t-tone-success': '#7fa68f',
  '--t-tone-success-bg': 'rgba(127, 166, 143, 0.14)',
  '--t-tone-success-border': 'rgba(127, 166, 143, 0.28)',
  '--t-tone-success-contrast': '#ffffff',
  '--t-tone-pending': '#a39565',
  '--t-tone-pending-bg': 'rgba(163, 149, 101, 0.14)',
  '--t-tone-pending-border': 'rgba(163, 149, 101, 0.28)',
  '--t-tone-fail': '#a37b7b',
  '--t-tone-fail-bg': 'rgba(163, 123, 123, 0.14)',
  '--t-tone-fail-border': 'rgba(163, 123, 123, 0.28)',
  // Brand orange — bright vermillion in both palettes. Used by the
  // Agents and Browser titlebar buttons so their active state glows.
  '--t-brand-orange': '#FF5A1F',
  '--t-brand-orange-contrast': '#0f1216',
  // Celebration
  '--t-celebration': '#c8923b',
  '--t-celebration-soft': 'rgba(200, 146, 59, 0.14)',
  '--t-celebration-border': 'rgba(200, 146, 59, 0.32)',
  '--t-celebration-glow': 'rgba(200, 146, 59, 0.32)',
  '--t-celebration-wash':
    'linear-gradient(90deg, rgba(200, 146, 59, 0) 0%, rgba(200, 146, 59, 0.18) 46%, rgba(255, 255, 255, 0.36) 54%, rgba(200, 146, 59, 0.12) 100%)',
  // Borders / dividers / overlays — rgba over either surface mode reads fine
  '--t-border': 'rgba(15, 23, 42, 0.1)',
  // Settings accent — deep editorial blue on light paper; the dark palette
  // overrides with a lighter blue so selection lifts off the graphite.
  '--t-settings-accent-strong': '#1D4ED8',
  '--t-settings-accent-active-bg': 'rgba(29, 78, 216, 0.1)',
  '--t-settings-accent-active-border': 'rgba(29, 78, 216, 0.32)',
  '--t-settings-accent-glow': 'rgba(29, 78, 216, 0.28)',
  '--t-panel-border': 'rgba(15, 23, 42, 0.1)',
  '--t-panel-shadow': '0 24px 60px rgba(40, 30, 20, 0.12), 0 6px 16px rgba(40, 30, 20, 0.06)',
  '--t-panel-hover': 'rgba(15, 23, 42, 0.04)',
  '--t-panel-active': 'rgba(37, 99, 235, 0.1)',
  '--t-input-border': 'rgba(15, 23, 42, 0.12)',
  '--t-divider': 'rgba(15, 23, 42, 0.08)',
  '--t-divider-strong': 'rgba(15, 23, 42, 0.14)',
  '--t-divider-subtle': 'rgba(15, 23, 42, 0.05)',
  '--t-hover': 'rgba(15, 23, 42, 0.04)',
  '--t-bg-card': 'rgba(15, 23, 42, 0.04)',
  '--t-code-bg': 'rgba(15, 23, 42, 0.06)',
  '--t-drag-handle': 'rgba(15, 23, 42, 0.22)',
  '--t-drag-handle-hover': '#94a3b8',
  // Rail selection shimmer flare — accent blue on light paper (report
  // 6BG69K: the orange pass read too quiet against light ink; blue carries
  // more contrast there). Dark keeps its ice-white via its own token.
  '--t-shimmer-flare': '#2563eb',
  '--t-search-border': 'rgba(15, 23, 42, 0.08)',
  '--t-btn-secondary-border': 'rgba(15, 23, 42, 0.12)',
  '--t-btn-secondary-hover': 'rgba(15, 23, 42, 0.06)',
  '--t-kbd-border': 'rgba(15, 23, 42, 0.14)',
  '--t-kbd-color': '#334155',
  '--t-glass-border-strong': 'rgba(15, 23, 42, 0.1)',
  '--t-tab-active-text': '#0f172a',
  '--t-tab-text': '#64748b',
  // Chat surface — pinned solid paper in both surface modes (always content,
  // never chrome). --t-canvas-bg is split per-surface below so the o8.md
  // editor and other canvas surfaces can be translucent in glass mode.
  '--t-chat-surface-bg': '#F4F2ED',
  '--t-chat-surface-text': '#0f172a',
  '--t-chat-surface-text-secondary': '#475569',
  '--t-chat-surface-text-muted': '#64748b',
  '--t-chat-surface-border': 'rgba(15, 23, 42, 0.08)',
  '--t-chat-surface-input-bg': '#F4F2ED',
  '--t-chat-surface-input-border': 'rgba(15, 23, 42, 0.12)',
  '--t-chat-surface-card-bg': 'rgba(15, 23, 42, 0.04)',
  // Terminal
  '--t-terminal-bg': '#F4F2ED',
  '--t-terminal-fg': '#0f172a',
  '--t-terminal-cursor': '#2563eb',
  '--t-terminal-cursor-accent': '#ffffff',
  '--t-terminal-selection-bg': 'rgba(37, 99, 235, 0.18)',
  '--t-terminal-selection-fg': '#0f172a',
  '--t-terminal-scrollbar-thumb': 'rgba(15, 23, 42, 0.16)',
  '--t-terminal-scrollbar-thumb-hover': 'rgba(15, 23, 42, 0.3)',
  '--t-terminal-ansi-black': '#111827',
  '--t-terminal-ansi-red': '#dc2626',
  '--t-terminal-ansi-green': '#16a34a',
  '--t-terminal-ansi-yellow': '#ca8a04',
  '--t-terminal-ansi-blue': '#2563eb',
  '--t-terminal-ansi-magenta': '#9333ea',
  '--t-terminal-ansi-cyan': '#0891b2',
  '--t-terminal-ansi-white': '#e5e7eb',
  '--t-terminal-ansi-bright-black': '#6b7280',
  '--t-terminal-ansi-bright-red': '#ef4444',
  '--t-terminal-ansi-bright-green': '#22c55e',
  '--t-terminal-ansi-bright-yellow': '#eab308',
  '--t-terminal-ansi-bright-blue': '#3b82f6',
  '--t-terminal-ansi-bright-magenta': '#a855f7',
  '--t-terminal-ansi-bright-cyan': '#06b6d4',
  '--t-terminal-ansi-bright-white': '#f9fafb',
};

const LIGHT_GLASS: Record<string, string> = {
  // Canvas surfaces (o8.md editor, code/diff viewers) read as glass over
  // vibrancy in light + glass — same treatment as the other o8 panel tabs.
  '--t-canvas-bg': 'rgba(0, 0, 0, 0)',
  '--t-bg': 'rgba(244, 242, 237, 0.62)',
  '--t-bg-gradient':
    'radial-gradient(circle at 0% 0%, rgba(244, 242, 237, 0.35) 0%, rgba(244, 242, 237, 0) 28%), linear-gradient(180deg, rgba(244, 242, 237, 0.56) 0%, rgba(238, 235, 227, 0.48) 100%)',
  '--t-bg-subtle': 'rgba(244, 242, 237, 0.58)',
  '--t-panel': 'rgba(244, 242, 237, 0.58)',
  '--t-panel-translucent': 'rgba(244, 242, 237, 0.44)',
  '--t-panel-solid':
    'linear-gradient(180deg, rgba(244, 242, 237, 0.92) 0%, rgba(238, 235, 227, 0.88) 100%)',
  '--t-input-bg': 'rgba(244, 242, 237, 0.7)',
  '--t-chrome': 'rgba(244, 242, 237, 0.5)',
  '--t-chrome-nav': 'rgba(244, 242, 237, 0.54)',
  '--t-chrome-timeline': 'rgba(244, 242, 237, 0.5)',
  '--t-search-bg': 'rgba(244, 242, 237, 0.5)',
  '--t-btn-secondary-bg': 'rgba(244, 242, 237, 0.55)',
  '--t-chrome-btn-bg': 'rgba(244, 242, 237, 0.72)',
  '--t-chrome-btn-hover-bg': 'rgba(244, 242, 237, 0.88)',
  '--t-chrome-btn-active-bg': 'rgba(244, 242, 237, 0.98)',
  '--t-chrome-btn-shadow':
    '0 1px 3px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.8)',
  '--t-chrome-btn-hover-shadow':
    '0 2px 8px rgba(15, 23, 42, 0.1), 0 1px 2px rgba(15, 23, 42, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.9)',
  '--t-chrome-btn-active-shadow':
    '0 3px 10px rgba(15, 23, 42, 0.12), 0 1px 2px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.95)',
  '--t-kbd-bg': 'rgba(244, 242, 237, 0.68)',
  '--t-timeline-bar': 'rgba(248, 250, 253, 0.6)',
  '--t-shell-backdrop': 'rgba(248, 250, 253, 0.28)',
  '--t-glass-elevated':
    'linear-gradient(180deg, rgba(244, 242, 237, 0.72) 0%, rgba(238, 235, 227, 0.6) 100%)',
  '--t-glass-muted': 'rgba(244, 242, 237, 0.5)',
  '--t-glass-muted-strong': 'rgba(244, 242, 237, 0.62)',
  '--t-glass-shadow':
    '0 32px 72px rgba(15, 23, 42, 0.12), 0 12px 32px rgba(15, 23, 42, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.9)',
  // Panel drag handles — light glass gets the DARK glass values verbatim
  // (Q ruling 2026-07-14): the light-ink pill vanished into the vibrancy
  // backdrop, which stays dark regardless of palette. Solid keeps the
  // palette's own ink via the base tokens.
  '--t-drag-handle': 'rgba(255, 255, 255, 0.22)',
  '--t-drag-handle-hover': '#5f6b7a',
};

// Solid light: opaque paper. Slight elevation between layers via tonal
// shifts (#FFFFFF brightest, #F4F2ED canvas, #EDE9DF subtle wells).
const LIGHT_SOLID: Record<string, string> = {
  '--t-canvas-bg': '#F4F2ED',
  '--t-bg': '#F4F2ED',
  '--t-bg-gradient': '#F4F2ED',
  '--t-bg-subtle': '#EFEDE6',
  '--t-panel': '#FAF9F4',
  '--t-panel-translucent': '#F4F2ED',
  '--t-panel-solid': '#FAF9F4',
  '--t-input-bg': '#FFFFFF',
  '--t-chrome': '#F4F2ED',
  '--t-chrome-nav': '#EFEDE6',
  '--t-chrome-timeline': '#F4F2ED',
  '--t-search-bg': '#FFFFFF',
  '--t-btn-secondary-bg': '#FAF9F4',
  '--t-chrome-btn-bg': '#FFFFFF',
  '--t-chrome-btn-hover-bg': '#F4F2ED',
  '--t-chrome-btn-active-bg': '#EAE7DD',
  '--t-chrome-btn-shadow':
    '0 1px 2px rgba(15, 23, 42, 0.06), inset 0 0 0 1px rgba(15, 23, 42, 0.06)',
  '--t-chrome-btn-hover-shadow':
    '0 2px 4px rgba(15, 23, 42, 0.08), inset 0 0 0 1px rgba(15, 23, 42, 0.08)',
  '--t-chrome-btn-active-shadow':
    '0 1px 2px rgba(15, 23, 42, 0.08), inset 0 0 0 1px rgba(37, 99, 235, 0.32)',
  '--t-kbd-bg': '#FFFFFF',
  '--t-timeline-bar': '#FAF9F4',
  '--t-shell-backdrop': '#F4F2ED',
  '--t-glass-elevated': '#FAF9F4',
  '--t-glass-muted': '#F4F2ED',
  '--t-glass-muted-strong': '#EFEDE6',
  '--t-glass-shadow':
    '0 16px 36px rgba(15, 23, 42, 0.06), 0 4px 12px rgba(15, 23, 42, 0.04), inset 0 0 0 1px rgba(15, 23, 42, 0.04)',
};

// ── Dark palette ─────────────────────────────────────────────────────────────

const DARK_BASE: Record<string, string> = {
  '--t-text': '#e8ecf2',
  '--t-text-strong': '#f5f8fc',
  '--t-text-secondary': '#bcc5d0',
  '--t-text-muted': '#8b95a3',
  '--t-text-faint': '#5f6b7a',
  '--t-accent': '#8fb4ff',
  '--t-accent-soft': 'rgba(143, 180, 255, 0.14)',
  '--t-accent-soft-strong': 'rgba(143, 180, 255, 0.22)',
  '--t-accent-border': 'rgba(143, 180, 255, 0.28)',
  '--t-accent-ring': 'rgba(143, 180, 255, 0.14)',
  '--t-success': '#86efac',
  '--t-success-soft': 'rgba(134, 239, 172, 0.14)',
  '--t-success-border': 'rgba(134, 239, 172, 0.24)',
  '--t-success-contrast': '#141414',
  '--t-warning': '#fbbf24',
  '--t-warning-soft': 'rgba(251, 191, 36, 0.14)',
  '--t-warning-border': 'rgba(251, 191, 36, 0.26)',
  '--t-warning-contrast': '#141414',
  '--t-danger': '#f87171',
  '--t-danger-soft': 'rgba(248, 113, 113, 0.14)',
  '--t-danger-border': 'rgba(248, 113, 113, 0.26)',
  '--t-danger-contrast': '#141414',
  '--t-tone-success': '#8bb99e',
  '--t-tone-success-bg': 'rgba(139, 185, 158, 0.16)',
  '--t-tone-success-border': 'rgba(139, 185, 158, 0.3)',
  '--t-tone-success-contrast': '#141414',
  '--t-tone-pending': '#c2ad70',
  '--t-tone-pending-bg': 'rgba(194, 173, 112, 0.16)',
  '--t-tone-pending-border': 'rgba(194, 173, 112, 0.3)',
  '--t-tone-fail': '#c28b8b',
  '--t-tone-fail-bg': 'rgba(194, 139, 139, 0.16)',
  '--t-tone-fail-border': 'rgba(194, 139, 139, 0.3)',
  '--t-brand-orange': '#FF5A1F',
  '--t-brand-orange-contrast': '#141414',
  '--t-celebration': '#f1c36a',
  '--t-celebration-soft': 'rgba(241, 195, 106, 0.14)',
  '--t-celebration-border': 'rgba(241, 195, 106, 0.3)',
  '--t-celebration-glow': 'rgba(241, 195, 106, 0.28)',
  '--t-celebration-wash':
    'linear-gradient(90deg, rgba(241, 195, 106, 0) 0%, rgba(241, 195, 106, 0.2) 46%, rgba(255, 255, 255, 0.1) 54%, rgba(241, 195, 106, 0.14) 100%)',
  '--t-border': 'rgba(255, 255, 255, 0.08)',
  // Settings accent — lighter blue than light-mode's #1D4ED8 so active states
  // read clearly against graphite (operator feedback 2026-07-05).
  '--t-settings-accent-strong': '#8FB4FF',
  '--t-settings-accent-active-bg': 'rgba(143, 180, 255, 0.16)',
  '--t-settings-accent-active-border': 'rgba(143, 180, 255, 0.42)',
  '--t-settings-accent-glow': 'rgba(143, 180, 255, 0.3)',
  '--t-panel-border': 'rgba(255, 255, 255, 0.08)',
  '--t-panel-shadow': '0 24px 60px rgba(0, 0, 0, 0.36)',
  '--t-panel-hover': 'rgba(255, 255, 255, 0.06)',
  '--t-panel-active': 'rgba(143, 180, 255, 0.18)',
  '--t-input-border': 'rgba(255, 255, 255, 0.1)',
  '--t-divider': 'rgba(255, 255, 255, 0.06)',
  '--t-divider-strong': 'rgba(255, 255, 255, 0.1)',
  '--t-divider-subtle': 'rgba(255, 255, 255, 0.04)',
  '--t-hover': 'rgba(255, 255, 255, 0.05)',
  '--t-bg-card': 'rgba(255, 255, 255, 0.04)',
  '--t-code-bg': 'rgba(0, 0, 0, 0.24)',
  '--t-drag-handle': 'rgba(255, 255, 255, 0.22)',
  '--t-drag-handle-hover': '#5f6b7a',
  // Rail selection shimmer flare — ice-white ink (Q: "the light blue was
  // good"). Defined in BOTH palette bases because ThemeProvider only SETS
  // vars on palette switch (never clears), so a light-only token would
  // leak its orange into dark.
  '--t-shimmer-flare': '#e8ecf2',
  '--t-search-border': 'rgba(255, 255, 255, 0.08)',
  '--t-btn-secondary-border': 'rgba(255, 255, 255, 0.1)',
  '--t-btn-secondary-hover': 'rgba(255, 255, 255, 0.06)',
  '--t-kbd-border': 'rgba(255, 255, 255, 0.1)',
  '--t-kbd-color': '#d0d8e4',
  '--t-glass-border-strong': 'rgba(255, 255, 255, 0.08)',
  '--t-tab-active-text': '#f5f8fc',
  '--t-tab-text': '#8b95a3',
  '--t-chat-surface-bg': '#242424',
  '--t-chat-surface-text': '#e8ecf2',
  '--t-chat-surface-text-secondary': '#8b95a3',
  '--t-chat-surface-text-muted': '#5f6b7a',
  '--t-chat-surface-border': 'rgba(255, 255, 255, 0.06)',
  '--t-chat-surface-input-bg': 'rgba(42, 42, 42, 0.5)',
  '--t-chat-surface-input-border': 'rgba(255, 255, 255, 0.1)',
  '--t-chat-surface-card-bg': 'rgba(255, 255, 255, 0.04)',
  '--t-terminal-bg': '#1e1e1e',
  '--t-terminal-fg': '#e8ecf2',
  '--t-terminal-cursor': '#8fb4ff',
  '--t-terminal-cursor-accent': '#141414',
  '--t-terminal-selection-bg': 'rgba(143, 180, 255, 0.26)',
  '--t-terminal-selection-fg': '#ffffff',
  '--t-terminal-scrollbar-thumb': 'rgba(255, 255, 255, 0.12)',
  '--t-terminal-scrollbar-thumb-hover': 'rgba(255, 255, 255, 0.24)',
  '--t-terminal-ansi-black': '#1e1e1e',
  '--t-terminal-ansi-red': '#f87171',
  '--t-terminal-ansi-green': '#86efac',
  '--t-terminal-ansi-yellow': '#fcd34d',
  '--t-terminal-ansi-blue': '#93c5fd',
  '--t-terminal-ansi-magenta': '#c4b5fd',
  '--t-terminal-ansi-cyan': '#67e8f9',
  '--t-terminal-ansi-white': '#d8dfe7',
  '--t-terminal-ansi-bright-black': '#5f6b7a',
  '--t-terminal-ansi-bright-red': '#fca5a5',
  '--t-terminal-ansi-bright-green': '#bbf7d0',
  '--t-terminal-ansi-bright-yellow': '#fde68a',
  '--t-terminal-ansi-bright-blue': '#bfdbfe',
  '--t-terminal-ansi-bright-magenta': '#ddd6fe',
  '--t-terminal-ansi-bright-cyan': '#a5f3fc',
  '--t-terminal-ansi-bright-white': '#f8fafc',
};

const DARK_GLASS: Record<string, string> = {
  // Dark glass carries NO base tint — the native HudWindow vibrancy already
  // reads as dark frosted glass, so any tint on top only fogs it. (Light glass
  // needs its 0.62 paper tint solely because the same dark vibrancy has to be
  // lightened.) Transparent base → crisp glass; only the center transcript
  // (--t-chat-surface-bg) stays opaque.
  '--t-bg': 'transparent',
  '--t-bg-gradient':
    'radial-gradient(circle at 0% 0%, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0) 22%), linear-gradient(180deg, rgba(32, 36, 42, 0.52) 0%, rgba(18, 20, 24, 0.48) 100%)',
  '--t-bg-subtle': 'rgba(56, 62, 72, 0.28)',
  '--t-panel': 'rgba(62, 68, 78, 0.36)',
  '--t-panel-translucent': 'rgba(72, 78, 88, 0.28)',
  '--t-panel-solid':
    'linear-gradient(180deg, rgba(42, 42, 42, 0.98) 0%, rgba(34, 34, 34, 0.96) 100%)',
  '--t-input-bg': 'rgba(42, 42, 42, 0.5)',
  '--t-chrome': 'rgba(28, 32, 38, 0.48)',
  '--t-chrome-nav': 'rgba(34, 38, 45, 0.52)',
  '--t-chrome-timeline': 'rgba(36, 40, 48, 0.5)',
  '--t-search-bg': 'rgba(255, 255, 255, 0.05)',
  '--t-btn-secondary-bg': 'rgba(62, 68, 78, 0.38)',
  '--t-chrome-btn-bg': 'rgba(255, 255, 255, 0.08)',
  '--t-chrome-btn-hover-bg': 'rgba(255, 255, 255, 0.16)',
  '--t-chrome-btn-active-bg': 'rgba(143, 180, 255, 0.18)',
  '--t-chrome-btn-shadow': 'inset 0 0 0 1px rgba(255, 255, 255, 0.12)',
  '--t-chrome-btn-hover-shadow': 'inset 0 0 0 1px rgba(255, 255, 255, 0.2)',
  '--t-chrome-btn-active-shadow':
    'inset 0 0 0 1px rgba(143, 180, 255, 0.36), 0 0 12px rgba(143, 180, 255, 0.28)',
  '--t-kbd-bg': 'rgba(255, 255, 255, 0.06)',
  '--t-canvas-bg': 'rgba(32, 32, 32, 0.44)',
  '--t-timeline-bar': 'rgba(62, 68, 78, 0.5)',
  '--t-shell-backdrop': 'rgba(10, 12, 16, 0.28)',
  '--t-glass-elevated':
    'linear-gradient(180deg, rgba(82, 88, 98, 0.3) 0%, rgba(52, 58, 66, 0.2) 100%)',
  '--t-glass-muted': 'rgba(68, 74, 84, 0.2)',
  '--t-glass-muted-strong': 'rgba(78, 84, 94, 0.24)',
  '--t-glass-shadow':
    '0 32px 72px rgba(0, 0, 0, 0.36), 0 10px 24px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
};

// Solid dark: opaque graphite. #1c1c1c base, #222222 chrome, #262626 panel,
// #2e2e2e inputs and chips. Tonal lift across layers stays small so the eye
// reads the surface as one continuous dark page.
const DARK_SOLID: Record<string, string> = {
  '--t-bg': '#1c1c1c',
  '--t-bg-gradient': '#242424',
  '--t-bg-subtle': '#222222',
  '--t-panel': '#262626',
  '--t-panel-translucent': '#222222',
  '--t-panel-solid': '#262626',
  '--t-input-bg': '#2a2a2a',
  '--t-chrome': '#202020',
  '--t-chrome-nav': '#222222',
  '--t-chrome-timeline': '#222222',
  '--t-search-bg': '#2a2a2a',
  '--t-btn-secondary-bg': '#2a2a2a',
  '--t-chrome-btn-bg': '#2e2e2e',
  '--t-chrome-btn-hover-bg': '#383838',
  '--t-chrome-btn-active-bg': '#39435C',
  '--t-chrome-btn-shadow': 'inset 0 0 0 1px rgba(255, 255, 255, 0.06)',
  '--t-chrome-btn-hover-shadow': 'inset 0 0 0 1px rgba(255, 255, 255, 0.12)',
  '--t-chrome-btn-active-shadow':
    'inset 0 0 0 1px rgba(143, 180, 255, 0.4), 0 0 8px rgba(143, 180, 255, 0.18)',
  '--t-kbd-bg': '#262626',
  '--t-canvas-bg': '#202020',
  '--t-timeline-bar': '#262626',
  '--t-shell-backdrop': '#1c1c1c',
  '--t-glass-elevated': '#262626',
  '--t-glass-muted': '#242424',
  '--t-glass-muted-strong': '#262626',
  '--t-glass-shadow':
    '0 16px 36px rgba(0, 0, 0, 0.4), 0 4px 12px rgba(0, 0, 0, 0.24), inset 0 0 0 1px rgba(255, 255, 255, 0.04)',
};

// ── Palette registry ─────────────────────────────────────────────────────────

export const PALETTES: ThemePalette[] = [
  {
    id: 'light',
    name: 'Light',
    colorScheme: 'light',
    preview: {
      bg: '#f0f4f8',
      panel: '#f7f9fc',
      nav: '#eef2f7',
      titlebar: '#ffffff',
      accent: '#2563eb',
      text: '#111827',
      textMuted: '#6b7280',
    },
    baseTokens: LIGHT_BASE,
    glassTokens: LIGHT_GLASS,
    solidTokens: LIGHT_SOLID,
  },
  {
    id: 'dark',
    name: 'Dark',
    colorScheme: 'dark',
    preview: {
      bg: '#202020',
      panel: '#2c2c2c',
      nav: '#262626',
      titlebar: '#222222',
      accent: '#8fb4ff',
      text: '#eef2f6',
      textMuted: '#8b95a3',
    },
    baseTokens: DARK_BASE,
    glassTokens: DARK_GLASS,
    solidTokens: DARK_SOLID,
  },
];

export function getPalette(id: PaletteId): ThemePalette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}
