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
  themeId: 'light',
  setTheme: () => {},
  themes: [],
});

export function useTheme() {
  return useContext(ThemeContext);
}

const STORAGE_KEY = 'cortex-theme';
const LEGACY_THEME_IDS: Record<string, string> = {
  chocolate: 'dark',
};

function normalizeThemeId(themeId: string | null) {
  if (!themeId) return null;
  return LEGACY_THEME_IDS[themeId] ?? themeId;
}

function readStoredThemeId() {
  if (typeof window === 'undefined') return 'light';
  try {
    const saved = normalizeThemeId(localStorage.getItem(STORAGE_KEY));
    return saved && themes.find((theme) => theme.id === saved) ? saved : 'light';
  } catch {
    return 'light';
  }
}

function applyThemeVars(theme: ThemeTokens, animate: boolean) {
  const root = document.documentElement;

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
