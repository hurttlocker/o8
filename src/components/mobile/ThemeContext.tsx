'use client';

import { createContext, useContext, useEffect, useCallback, type ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ColorPalette {
  bg: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  cardBg: string;
  cardBorder: string;
  blueAccent: string;
  blueGlass: string;
  blueGlassBorder: string;
  blueSoft: string;
  composeBg: string;
  composeBorder: string;
  frostBg: string;
  frostStrong: string;
  panelBg: string;
  msgUserBg: string;
  msgAssistantBg: string;
  border: string;
  shadow: string;
  green: string;
  amber: string;
  red: string;
  notifBg: string;
  notifBorder: string;
  dismissBg: string;
  pillTextInactive: string;
}

const DARK_COLORS: ColorPalette = {
  bg: '#000000',
  text: '#F5F5F7',
  textSecondary: '#8E8E93',
  textTertiary: '#636366',
  cardBg: 'rgba(28,28,30,0.82)',
  cardBorder: 'rgba(255,255,255,0.08)',
  blueAccent: '#0A84FF',
  blueGlass: 'rgba(10,132,255,0.12)',
  blueGlassBorder: 'rgba(10,132,255,0.2)',
  blueSoft: 'rgba(10,132,255,0.08)',
  composeBg: 'rgba(28,28,30,0.82)',
  composeBorder: 'rgba(255,255,255,0.08)',
  frostBg: 'rgba(28,28,30,0.92)',
  frostStrong: '#000000',
  panelBg: 'rgba(28,28,30,0.82)',
  msgUserBg: 'rgba(10,132,255,0.15)',
  msgAssistantBg: 'rgba(28,28,30,0.82)',
  border: 'rgba(255,255,255,0.08)',
  shadow: '0 2px 8px rgba(0,0,0,0.2)',
  green: '#30d158',
  amber: '#ffd60a',
  red: '#ff453a',
  notifBg: 'rgba(10,132,255,0.1)',
  notifBorder: 'rgba(10,132,255,0.18)',
  dismissBg: 'rgba(10,132,255,0.12)',
  pillTextInactive: 'rgba(100,160,255,0.7)',
};

interface ThemeContextValue {
  theme: Theme;
  isDark: boolean;
  setTheme: (t: Theme) => void;
  toggle: () => void;
  colors: ColorPalette;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  isDark: true,
  setTheme: () => {},
  toggle: () => {},
  colors: DARK_COLORS,
});

export function useTheme() {
  return useContext(ThemeContext);
}

const STORAGE_KEY = 'cortex-theme';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme: Theme = 'dark';
  const isDark = true;

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;

    html.classList.add('dark-mode');
    body.classList.add('dark-mode');
    html.style.backgroundColor = DARK_COLORS.bg;
    body.style.backgroundColor = DARK_COLORS.bg;
    html.style.colorScheme = 'dark';

    try {
      window.sessionStorage.setItem(STORAGE_KEY, 'dark');
    } catch {
      // Ignore storage failures on constrained browsers.
    }

    return () => {
      html.classList.remove('dark-mode');
      body.classList.remove('dark-mode');
      html.style.backgroundColor = '';
      body.style.backgroundColor = '';
      html.style.colorScheme = '';
    };
  }, []);

  const setTheme = useCallback((nextTheme: Theme) => {
    void nextTheme;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, 'dark');
    } catch {
      // Ignore storage failures on constrained browsers.
    }
  }, []);

  const toggle = useCallback(() => {
    // Mobile is dark-only for v1.
  }, []);
  const colors = DARK_COLORS;

  return (
    <ThemeContext.Provider value={{ theme, isDark, setTheme, toggle, colors }}>
      {children}
    </ThemeContext.Provider>
  );
}
