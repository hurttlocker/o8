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
  const [themeId, setThemeId] = useState('light');

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && themes.find(t => t.id === saved)) {
      setThemeId(saved);
      applyThemeVars(themes.find(t => t.id === saved)!, false);
    } else {
      applyThemeVars(themes[0], false);
    }
  }, []);

  const setTheme = useCallback((id: string) => {
    const theme = themes.find(t => t.id === id);
    if (!theme) return;
    setThemeId(id);
    localStorage.setItem(STORAGE_KEY, id);
    applyThemeVars(theme, true);
  }, []);

  return (
    <ThemeContext.Provider value={{ themeId, setTheme, themes }}>
      {children}
    </ThemeContext.Provider>
  );
}
