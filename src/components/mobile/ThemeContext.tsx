'use client';

import { createContext, useContext, useEffect, useCallback, type ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ColorPalette {
  bg: string;
  surface: string;
  surfaceBorder: string;
  accent: string;
  success: string;
  danger: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  cardBg: string;
  cardBorder: string;
  elevatedSurface: string;
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
  activityTimelineLine: string;
  activityCardBg: string;
  activityCardBorder: string;
  activityStatusCoding: string;
  activityStatusThinking: string;
  activityStatusTesting: string;
  activityStatusError: string;
  activityStatusSuccess: string;
  activityStatusIdle: string;
}

export const DARK_COLORS: ColorPalette = {
  bg: '#1C1C1E',
  surface: 'rgba(30,28,26,0.82)',
  surfaceBorder: 'rgba(255,248,240,0.07)',
  accent: '#0A84FF',
  success: '#30D158',
  danger: '#FF453A',
  text: '#FAF5F0',
  textSecondary: '#A09890',
  textTertiary: '#706860',
  cardBg: 'rgba(32,28,24,0.75)',
  cardBorder: 'rgba(255,248,240,0.07)',
  elevatedSurface: 'rgba(46,42,38,0.9)',
  blueAccent: 'rgba(255,248,240,0.18)',
  blueGlass: 'rgba(255,248,240,0.06)',
  blueGlassBorder: 'rgba(255,248,240,0.1)',
  blueSoft: 'rgba(255,248,240,0.04)',
  composeBg: 'rgba(30,28,26,0.82)',
  composeBorder: 'rgba(255,248,240,0.07)',
  frostBg: 'rgba(30,28,26,0.92)',
  frostStrong: '#0A0A0A',
  panelBg: 'rgba(30,28,26,0.82)',
  msgUserBg: 'rgba(10,132,255,0.15)',
  msgAssistantBg: 'rgba(30,28,26,0.82)',
  border: 'rgba(255,248,240,0.07)',
  shadow: '0 2px 8px rgba(0,0,0,0.2)',
  green: '#30D158',
  amber: '#ffd60a',
  red: '#FF453A',
  notifBg: 'rgba(10,132,255,0.1)',
  notifBorder: 'rgba(10,132,255,0.18)',
  dismissBg: 'rgba(10,132,255,0.12)',
  pillTextInactive: 'rgba(100,160,255,0.7)',
  activityTimelineLine: 'rgba(255,248,240,0.06)',
  activityCardBg: 'rgba(30,28,26,0.82)',
  activityCardBorder: 'rgba(255,248,240,0.06)',
  activityStatusCoding: '#0A84FF',
  activityStatusThinking: '#64D2FF',
  activityStatusTesting: '#FF9F0A',
  activityStatusError: '#FF453A',
  activityStatusSuccess: '#30D158',
  activityStatusIdle: '#706860',
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
