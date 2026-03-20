'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: Theme;
  isDark: boolean;
  setTheme: (t: Theme) => void;
  toggle: () => void;
  // Dark mode color palette for inline styles
  colors: typeof LIGHT_COLORS;
}

const LIGHT_COLORS = {
  bg: '#f5f7fb',
  text: '#0a0a0a',
  textSecondary: '#64748b',
  textTertiary: '#8e8e93',
  cardBg: 'rgba(0,122,255,0.03)',
  cardBorder: 'rgba(0,122,255,0.08)',
  blueAccent: '#007aff',
  blueGlass: 'rgba(0,122,255,0.08)',
  blueGlassBorder: 'rgba(0,122,255,0.15)',
  blueSoft: 'rgba(0,122,255,0.06)',
  composeBg: 'rgba(219,234,254,0.6)',
  composeBorder: 'rgba(191,219,254,0.24)',
  frostBg: 'rgba(255,255,255,0.92)',
  frostStrong: 'rgba(255,255,255,1)',
  panelBg: 'rgba(255,255,255,0.82)',
  msgUserBg: 'rgba(0,122,255,0.08)',
  msgAssistantBg: 'rgba(255,255,255,0.9)',
  border: 'rgba(0,0,0,0.04)',
  shadow: '0 2px 8px rgba(0,0,0,0.04)',
  green: '#34c759',
  amber: '#ff9f0a',
  red: '#ff3b30',
  // Notification/compose
  notifBg: 'rgba(0,122,255,0.06)',
  notifBorder: 'rgba(0,122,255,0.12)',
  dismissBg: 'rgba(0,122,255,0.08)',
  pillTextInactive: 'rgba(0,80,200,0.7)',
};

const DARK_COLORS: typeof LIGHT_COLORS = {
  bg: '#000000',
  text: '#f5f5f7',
  textSecondary: '#98989d',
  textTertiary: '#636366',
  cardBg: 'rgba(10,132,255,0.06)',
  cardBorder: 'rgba(10,132,255,0.12)',
  blueAccent: '#0a84ff',
  blueGlass: 'rgba(10,132,255,0.12)',
  blueGlassBorder: 'rgba(10,132,255,0.2)',
  blueSoft: 'rgba(10,132,255,0.08)',
  composeBg: 'rgba(28,28,30,0.8)',
  composeBorder: 'rgba(56,56,58,0.5)',
  frostBg: 'rgba(28,28,30,0.92)',
  frostStrong: 'rgba(0,0,0,1)',
  panelBg: 'rgba(28,28,30,0.82)',
  msgUserBg: 'rgba(10,132,255,0.15)',
  msgAssistantBg: 'rgba(44,44,46,0.9)',
  border: 'rgba(255,255,255,0.06)',
  shadow: '0 2px 8px rgba(0,0,0,0.2)',
  green: '#30d158',
  amber: '#ffd60a',
  red: '#ff453a',
  notifBg: 'rgba(10,132,255,0.1)',
  notifBorder: 'rgba(10,132,255,0.18)',
  dismissBg: 'rgba(10,132,255,0.12)',
  pillTextInactive: 'rgba(100,160,255,0.7)',
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'light',
  isDark: false,
  setTheme: () => {},
  toggle: () => {},
  colors: LIGHT_COLORS,
});

export function useTheme() {
  return useContext(ThemeContext);
}

const STORAGE_KEY = 'cortex-theme';

function isTheme(value: string | null): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  try {
    const saved = window.sessionStorage.getItem(STORAGE_KEY);
    return isTheme(saved) ? saved : 'light';
  } catch {
    return 'light';
  }
}

function readSystemDarkPreference() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [systemDark, setSystemDark] = useState(readSystemDarkPreference);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);

    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }

    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);

  const isDark = theme === 'dark' || (theme === 'system' && systemDark);

  // Apply dark-mode class to html AND body (belt and suspenders)
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    if (isDark) {
      html.classList.add('dark-mode');
      body.classList.add('dark-mode');
      html.style.backgroundColor = '#000000';
      body.style.backgroundColor = '#000000';
      html.style.colorScheme = 'dark';
    } else {
      html.classList.remove('dark-mode');
      body.classList.remove('dark-mode');
      html.style.backgroundColor = '#f5f7fb';
      body.style.backgroundColor = '#f5f7fb';
      html.style.colorScheme = 'light';
    }
  }, [isDark]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      sessionStorage.setItem(STORAGE_KEY, t);
    } catch {
      // Ignore storage failures on constrained browsers.
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(isDark ? 'light' : 'dark');
  }, [isDark, setTheme]);

  const colors = isDark ? DARK_COLORS : LIGHT_COLORS;

  return (
    <ThemeContext.Provider value={{ theme, isDark, setTheme, toggle, colors }}>
      {children}
    </ThemeContext.Provider>
  );
}
