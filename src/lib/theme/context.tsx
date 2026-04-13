'use client';

/**
 * ThemeProvider — manages theme state and applies CSS custom properties.
 *
 * On theme change:
 * 1. Updates CSS vars on <html>
 * 2. Injects brief transition for smooth visual switch
 * 3. Persists selection to localStorage
 */

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { themes, type ThemeTokens } from './themes';

interface ThemeContextValue {
  themeId: string;
  setTheme: (id: string) => void;
  themes: ThemeTokens[];
}

const ThemeContext = createContext<ThemeContextValue>({
  themeId: 'midnight',
  setTheme: () => {},
  themes: [],
});

export function useTheme() {
  return useContext(ThemeContext);
}

const STORAGE_KEY = 'cortex-theme';
// Legacy ids get remapped onto shipping themes. `dark` used to be its own
// variant — it's gone now, so anyone still stored on it lands on midnight.
const LEGACY_THEME_IDS: Record<string, string> = {
  chocolate: 'midnight',
  dark: 'midnight',
};

function normalizeThemeId(themeId: string | null) {
  if (!themeId) return null;
  return LEGACY_THEME_IDS[themeId] ?? themeId;
}

function readStoredThemeId() {
  if (typeof window === 'undefined') return 'midnight';
  try {
    const saved = normalizeThemeId(localStorage.getItem(STORAGE_KEY));
    return saved && themes.find((theme) => theme.id === saved) ? saved : 'midnight';
  } catch {
    return 'midnight';
  }
}

function applyThemeVars(theme: ThemeTokens, animate: boolean) {
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
    setTimeout(() => { styleEl?.remove(); }, 700);
  }

  for (const [key, value] of Object.entries(theme.cssVars)) {
    root.style.setProperty(key, value);
  }

  // Tauri vibrancy: both shipping themes (light + midnight) pass chrome
  // through to the OS vibrancy backdrop. Light reads as frosted silver
  // glass with dark text; midnight reads as dark graphite glass with
  // light text. The workspace/terminal/chat-surface tokens stay solid
  // per-theme so the main content area is never translucent.
  if (root.dataset.tauri === 'true') {
    root.style.setProperty('--t-chrome', 'transparent');
    root.style.setProperty('--t-bg-gradient', 'transparent');
    root.style.setProperty('--t-chrome-nav', 'transparent');

    let vibrancyStyle = document.getElementById('tauri-vibrancy-overrides');
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
  }

  // Chrome-surface scope — flips text + button tokens to glass-on-white for
  // regions that sit on top of the vibrancy bleed in light mode. Chrome
  // surfaces are marked with `data-chrome-surface="true"` in the component
  // tree (right panel, title bar right-controls, etc). In midnight the
  // normal text tokens are already light, so this scope is a no-op and
  // lives only under the light theme selector.
  let chromeScopeStyle = document.getElementById('theme-chrome-surface');
  if (!chromeScopeStyle) {
    chromeScopeStyle = document.createElement('style');
    chromeScopeStyle.id = 'theme-chrome-surface';
    document.head.appendChild(chromeScopeStyle);
  }
  chromeScopeStyle.textContent = `
    [data-theme="light"] [data-chrome-surface="true"] {
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
      --t-chrome-btn-active-bg: rgba(255, 255, 255, 0.24);
      --t-chrome-btn-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
      --t-chrome-btn-hover-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2);
      --t-chrome-btn-active-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.28);
      --t-chrome-btn-text: rgba(255, 255, 255, 0.96);
    }
  `;

  root.style.colorScheme = theme.colorScheme;
  root.dataset.theme = theme.id;
  if (body) {
    body.dataset.theme = theme.id;
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeId, setThemeId] = useState(readStoredThemeId);

  useEffect(() => {
    const selectedTheme = themes.find((theme) => theme.id === themeId) ?? themes[0];
    applyThemeVars(selectedTheme, false);
  }, [themeId]);

  const setTheme = useCallback((id: string) => {
    const normalizedId = normalizeThemeId(id);
    if (!normalizedId) return;
    const theme = themes.find(t => t.id === normalizedId);
    if (!theme) return;
    setThemeId(normalizedId);
    localStorage.setItem(STORAGE_KEY, normalizedId);
    applyThemeVars(theme, true);
  }, []);

  return (
    <ThemeContext.Provider value={{ themeId, setTheme, themes }}>
      {children}
    </ThemeContext.Provider>
  );
}
