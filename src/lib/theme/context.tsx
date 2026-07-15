'use client';

/**
 * ThemeProvider — manages palette + surface state and applies CSS custom
 * properties to <html>.
 *
 * Two-axis model:
 *   - Palette: 'light' | 'dark'         (color family, user-facing)
 *   - Surface: 'glass' | 'solid'         (chrome layer, driven by reduce-transparency)
 *
 * Public API (kept backwards compatible — legacy callers pass `themeId`):
 *   - paletteId, setPalette, palettes
 *   - surface, reduceTransparency, setReduceTransparency
 *   - themeId (composed `${palette}-${surface}`), setTheme (accepts both
 *     legacy ids 'light'/'midnight'/'dark' and composed ids)
 *   - themes: ResolvedTheme[] for legacy enumerators
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import {
  PALETTES,
  resolveTheme,
  getPalette,
  type PaletteId,
  type SurfaceMode,
  type ThemePalette,
  type ResolvedTheme,
} from './registry';

export type ReduceTransparency = 'on' | 'off' | 'system';

interface ThemeContextValue {
  // New API
  paletteId: PaletteId;
  setPalette: (id: PaletteId) => void;
  palettes: ThemePalette[];
  surface: SurfaceMode;
  reduceTransparency: ReduceTransparency;
  setReduceTransparency: (v: ReduceTransparency) => void;
  systemReduceTransparency: boolean;
  // Legacy API (kept for existing call sites)
  themeId: string;
  setTheme: (id: string) => void;
  themes: ResolvedTheme[];
}

const ThemeContext = createContext<ThemeContextValue>({
  paletteId: 'light',
  setPalette: () => {},
  palettes: PALETTES,
  surface: 'solid',
  reduceTransparency: 'on',
  setReduceTransparency: () => {},
  systemReduceTransparency: false,
  themeId: 'light-solid',
  setTheme: () => {},
  themes: [],
});

export function useTheme() {
  return useContext(ThemeContext);
}

const PALETTE_STORAGE_KEY = 'cortex-theme-palette';
const TRANSPARENCY_STORAGE_KEY = 'cortex-reduce-transparency';
const LEGACY_THEME_KEY = 'cortex-theme';
const FRESH_INSTALL_PALETTE: PaletteId = 'light';
const FRESH_INSTALL_REDUCE_TRANSPARENCY: ReduceTransparency = 'on';

// Legacy theme ids → palette ids. 'midnight' was the only dark variant; it
// gets renamed to 'dark' here to align with macOS naming conventions.
const LEGACY_PALETTE_REMAP: Record<string, PaletteId> = {
  light: 'light',
  midnight: 'dark',
  dark: 'dark',
  chocolate: 'dark',
};

function hasStoredThemePreference() {
  return (
    localStorage.getItem(PALETTE_STORAGE_KEY) !== null ||
    localStorage.getItem(TRANSPARENCY_STORAGE_KEY) !== null ||
    localStorage.getItem(LEGACY_THEME_KEY) !== null
  );
}

function readPaletteId(): PaletteId {
  if (typeof window === 'undefined') return FRESH_INSTALL_PALETTE;
  try {
    const stored = localStorage.getItem(PALETTE_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    // Migration: read legacy key
    const legacy = localStorage.getItem(LEGACY_THEME_KEY);
    if (legacy && LEGACY_PALETTE_REMAP[legacy]) return LEGACY_PALETTE_REMAP[legacy];
    if (hasStoredThemePreference()) return 'dark';
  } catch {
    // localStorage unavailable
  }
  return FRESH_INSTALL_PALETTE;
}

function readReduceTransparency(): ReduceTransparency {
  if (typeof window === 'undefined') return FRESH_INSTALL_REDUCE_TRANSPARENCY;
  try {
    const stored = localStorage.getItem(TRANSPARENCY_STORAGE_KEY);
    if (stored === 'on' || stored === 'off' || stored === 'system') return stored;
    if (hasStoredThemePreference()) return 'system';
  } catch {
    // localStorage unavailable
  }
  return FRESH_INSTALL_REDUCE_TRANSPARENCY;
}

/**
 * Resolve the effective surface mode based on user preference + system
 * reduce-transparency setting. The `system` value mirrors macOS's
 * Accessibility → Display → Reduce transparency toggle (read via Tauri
 * IPC in a follow-up; for now defaults to glass).
 */
function resolveSurface(
  pref: ReduceTransparency,
  systemReduceTransparency: boolean,
): SurfaceMode {
  if (pref === 'on') return 'solid';
  if (pref === 'off') return 'glass';
  return systemReduceTransparency ? 'solid' : 'glass';
}

function applyThemeVars(theme: ResolvedTheme, animate: boolean) {
  const root = document.documentElement;
  const body = document.body;

  if (animate) {
    let styleEl = document.getElementById('theme-transition');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'theme-transition';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = [
      '*, *::before, *::after {',
      '  transition: background-color 0.5s ease,',
      '    color 0.4s ease,',
      '    border-color 0.4s ease,',
      '    box-shadow 0.4s ease,',
      '    background 0.5s ease !important;',
      '}',
    ].join('\n');
    setTimeout(() => {
      styleEl?.remove();
    }, 700);
  }

  for (const [key, value] of Object.entries(theme.cssVars)) {
    root.style.setProperty(key, value);
  }

  // Tauri detection — self-heals if the inline data-tauri attribute from
  // layout.tsx raced the runtime. Only matters for vibrancy passthrough,
  // which itself only matters in glass surface mode.
  const hasTauriInternals =
    typeof window !== 'undefined' &&
    typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
      'undefined';
  if (hasTauriInternals && root.dataset.tauri !== 'true') {
    root.dataset.tauri = 'true';
    if (body) body.dataset.tauri = 'true';
    root.style.background = '';
    if (body) body.style.background = '';
  }

  const inTauri = root.dataset.tauri === 'true';

  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: {
      invoke?: (cmd: string, args: unknown) => Promise<unknown>;
      metadata?: { currentWindow?: { label?: string } };
    };
  }).__TAURI_INTERNALS__;

  // Pin the native window appearance to the palette (glass-slab root cause,
  // 2026-07-14): NSVisualEffectView materials render their LIGHT or DARK
  // variant from the window's effectiveAppearance, which otherwise follows
  // the SYSTEM appearance. A dark system under the light palette rendered
  // every glass material as the heavy dark slab ("I hit glass and it's
  // still opaque"). Palette-pinned appearance makes glass deterministic —
  // a system appearance change (manual or sunset auto-switch) can never
  // flip the chrome material again. Applies in solid mode too so the
  // titlebar/traffic-light chrome always matches the palette.
  if (inTauri) {
    const label = internals?.metadata?.currentWindow?.label ?? 'main';
    internals?.invoke?.('plugin:window|set_theme', {
      label,
      value: theme.paletteId === 'light' ? 'light' : 'dark',
    })?.catch((err: unknown) => console.warn('[theme] window appearance pin failed', err));
  }

  // Vibrancy passthrough — only in Tauri AND glass surface mode. In solid
  // mode the chrome tokens are fully opaque and we WANT them painted on
  // top of whatever vibrancy material the OS still has applied (a Phase 2
  // follow-up will toggle the macOS material itself for GPU savings).
  let vibrancyStyle = document.getElementById('tauri-vibrancy-overrides');
  if (inTauri && theme.surface === 'glass') {
    // Webview-driven vibrancy re-assert (#1543): the Rust boot-time
    // apply_vibrancy can silently fail to render on macOS 26 / 15.7.8 (the
    // effect view attaches before the window is truly ready and never
    // paints — a runtime clear+re-apply always cures it). The frontend
    // mounting IS the proof the window is fully live, so re-assert from
    // here: 'default' maps to the per-OS chrome material on the Rust side.
    // Idempotent, and re-running on theme changes is desirable.
    internals?.invoke?.('set_canvas_material', { material: 'default' })
      ?.catch((err: unknown) => console.warn('[theme] vibrancy re-assert failed', err));
    root.style.setProperty('--t-chrome', 'transparent');
    root.style.setProperty('--t-bg-gradient', 'transparent');
    root.style.setProperty('--t-chrome-nav', 'transparent');
    if (!vibrancyStyle) {
      vibrancyStyle = document.createElement('style');
      vibrancyStyle.id = 'tauri-vibrancy-overrides';
      document.head.appendChild(vibrancyStyle);
    }
    vibrancyStyle.textContent = `
      [data-vibrancy-passthrough] {
        background: transparent !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
    `;
  } else if (vibrancyStyle) {
    vibrancyStyle.remove();
  }

  // Chrome-surface scope — in glass mode the chrome panels (left rail, right
  // panel) sit on the DARK macOS vibrancy material in BOTH palettes, so their
  // text/borders must flip to white-alpha to stay legible. Light glass always
  // did this; dark glass needs the SAME treatment (its DARK_BASE tokens read
  // muddy on the transparent vibrancy) — one shared block, since "white on dark
  // vibrancy" is correct for either palette. Only the center transcript keeps
  // its own opaque surface. Solid mode paints opaque chrome and needs none.
  let chromeScopeStyle = document.getElementById('theme-chrome-surface');
  const needsChromeFlip = theme.surface === 'glass';
  if (needsChromeFlip) {
    if (!chromeScopeStyle) {
      chromeScopeStyle = document.createElement('style');
      chromeScopeStyle.id = 'theme-chrome-surface';
      document.head.appendChild(chromeScopeStyle);
    }
    chromeScopeStyle.textContent = `
      [data-surface="glass"] [data-chrome-surface="true"] {
        --t-bg: transparent;
        --t-bg-subtle: transparent;
        --t-panel: transparent;
        --t-panel-translucent: transparent;
        --t-panel-solid: transparent;
        --t-text: rgba(255, 255, 255, 0.96);
        --t-text-strong: #ffffff;
        --t-text-secondary: rgba(255, 255, 255, 0.78);
        --t-text-muted: rgba(255, 255, 255, 0.6);
        --t-text-faint: rgba(255, 255, 255, 0.42);
        --t-tab-active-text: #ffffff;
        --t-tab-text: rgba(255, 255, 255, 0.6);
        --t-border: rgba(255, 255, 255, 0.14);
        --t-divider: rgba(255, 255, 255, 0.12);
        --t-divider-strong: rgba(255, 255, 255, 0.2);
        --t-divider-subtle: rgba(255, 255, 255, 0.07);
        --t-hover: rgba(255, 255, 255, 0.1);
        --t-panel-border: rgba(255, 255, 255, 0.14);
        --t-panel-hover: rgba(255, 255, 255, 0.08);
        --t-btn-secondary-bg: rgba(255, 255, 255, 0.1);
        --t-btn-secondary-border: rgba(255, 255, 255, 0.16);
        --t-btn-secondary-hover: rgba(255, 255, 255, 0.16);
        --t-input-bg: rgba(255, 255, 255, 0.08);
        --t-input-border: rgba(255, 255, 255, 0.16);
        --t-bg-card: rgba(255, 255, 255, 0.06);
        --t-code-bg: rgba(255, 255, 255, 0.08);
        --t-chrome-btn-bg: rgba(255, 255, 255, 0.08);
        --t-chrome-btn-hover-bg: rgba(255, 255, 255, 0.16);
        --t-chrome-btn-active-bg: rgba(143, 180, 255, 0.18);
        --t-chrome-btn-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
        --t-chrome-btn-hover-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2);
        --t-chrome-btn-active-shadow: inset 0 0 0 1px rgba(143, 180, 255, 0.36), 0 0 12px rgba(143, 180, 255, 0.28);
        --t-chrome-btn-text: rgba(255, 255, 255, 0.96);
        --t-accent: #8fb4ff;
        --t-accent-soft: rgba(143, 180, 255, 0.14);
        --t-accent-soft-strong: rgba(143, 180, 255, 0.22);
        --t-accent-border: rgba(143, 180, 255, 0.28);
        --t-accent-ring: rgba(143, 180, 255, 0.14);
        /* Semantic status colors — the LIGHT_BASE values (#16a34a green,
           #ef4444 red, #f97316 amber) are tuned for cream paper and read
           dark/low-contrast over the dark vibrancy a glass chrome panel
           bleeds. Adopt the DARK_BASE (brightened) set here so any element
           using var(--t-success|warning|danger) inside a chrome panel lifts
           to a legible value. Token-based surfaces (e.g. the footer ports
           badge) brighten for free; cream surfaces keep the dark variant. */
        --t-success: #86efac;
        --t-success-soft: rgba(134, 239, 172, 0.14);
        --t-success-border: rgba(134, 239, 172, 0.24);
        --t-success-contrast: #0f1216;
        --t-warning: #fbbf24;
        --t-warning-soft: rgba(251, 191, 36, 0.14);
        --t-warning-border: rgba(251, 191, 36, 0.26);
        --t-warning-contrast: #0f1216;
        --t-danger: #f87171;
        --t-danger-soft: rgba(248, 113, 113, 0.14);
        --t-danger-border: rgba(248, 113, 113, 0.26);
        --t-danger-contrast: #0f1216;
      }
    `;
  } else if (chromeScopeStyle) {
    chromeScopeStyle.remove();
  }

  // data-theme = palette id (preserves legacy CSS selectors like
  // `[data-theme='light']`). data-palette is an alias of the same value.
  // data-surface is the new axis ('glass' | 'solid'); CSS that needs both
  // can compound: `[data-palette='light'][data-surface='glass']`.
  root.style.colorScheme = theme.colorScheme;
  root.dataset.theme = theme.paletteId;
  root.dataset.palette = theme.paletteId;
  root.dataset.surface = theme.surface;
  if (body) {
    body.dataset.theme = theme.paletteId;
    body.dataset.palette = theme.paletteId;
    body.dataset.surface = theme.surface;
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [paletteId, setPaletteId] = useState<PaletteId>(() => readPaletteId());
  const [reduceTransparency, setReduceTransparencyState] = useState<ReduceTransparency>(
    () => readReduceTransparency(),
  );
  // Phase 2 hookup point: read macOS NSWorkspace
  // accessibilityDisplayShouldReduceTransparency via Tauri IPC. For now
  // stays false — 'system' preference resolves to 'glass'. When the IPC
  // lands, swap this to a useState seeded by an initial Tauri call +
  // an effect subscribing to system setting changes.
  const [systemReduceTransparency] = useState(false);

  const surface = useMemo(
    () => resolveSurface(reduceTransparency, systemReduceTransparency),
    [reduceTransparency, systemReduceTransparency],
  );

  const palette = useMemo(() => getPalette(paletteId), [paletteId]);
  const resolved = useMemo(() => resolveTheme(palette, surface), [palette, surface]);

  // Mount once without animation, then animate on every subsequent change.
  const mountedRef = useRef(false);
  useEffect(() => {
    applyThemeVars(resolved, mountedRef.current);
    mountedRef.current = true;
  }, [resolved]);

  const setPalette = useCallback((id: PaletteId) => {
    setPaletteId(id);
    try {
      localStorage.setItem(PALETTE_STORAGE_KEY, id);
      // Drop legacy key so it doesn't fight us on next boot
      localStorage.removeItem(LEGACY_THEME_KEY);
    } catch {
      /* noop */
    }
  }, []);

  const setReduceTransparency = useCallback((v: ReduceTransparency) => {
    setReduceTransparencyState(v);
    try {
      localStorage.setItem(TRANSPARENCY_STORAGE_KEY, v);
    } catch {
      /* noop */
    }
  }, []);

  // Legacy: setTheme accepts old ids ('light'/'midnight'/'dark'/'chocolate')
  // OR composed ids ('light-glass'/'light-solid'/etc). Old ids only set
  // the palette; transparency stays where it is.
  const setTheme = useCallback(
    (id: string) => {
      // Composed id?
      if (id.includes('-')) {
        const [pal, surf] = id.split('-');
        if ((pal === 'light' || pal === 'dark') && (surf === 'glass' || surf === 'solid')) {
          setPalette(pal);
          setReduceTransparency(surf === 'solid' ? 'on' : 'off');
          return;
        }
      }
      const remapped = LEGACY_PALETTE_REMAP[id];
      if (remapped) setPalette(remapped);
    },
    [setPalette, setReduceTransparency],
  );

  const themes = useMemo(
    () => PALETTES.flatMap((p) => [resolveTheme(p, 'glass'), resolveTheme(p, 'solid')]),
    [],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      paletteId,
      setPalette,
      palettes: PALETTES,
      surface,
      reduceTransparency,
      setReduceTransparency,
      systemReduceTransparency,
      // Legacy: themeId returns the palette id only (e.g. 'light' / 'dark')
      // so existing call sites doing `themeId === 'light'` keep working.
      // Use `surface` and `reduceTransparency` for the new axis.
      themeId: resolved.paletteId,
      setTheme,
      themes,
    }),
    [
      paletteId,
      setPalette,
      surface,
      reduceTransparency,
      setReduceTransparency,
      systemReduceTransparency,
      resolved.paletteId,
      setTheme,
      themes,
    ],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
