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

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('light');
  const [systemDark, setSystemDark] = useState(false);

  // Load saved theme after mount
  useEffect(() => {
    const saved = sessionStorage.getItem(STORAGE_KEY) as Theme | null;
    if (saved && (saved === 'light' || saved === 'dark' || saved === 'system')) {
      setThemeState(saved);
    }

    // Listen to system preference
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(mq.matches);
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const isDark = theme === 'dark' || (theme === 'system' && systemDark);

  // Apply class to documentElement
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark-mode');
      document.documentElement.style.backgroundColor = '#000000';
    } else {
      document.documentElement.classList.remove('dark-mode');
      document.documentElement.style.backgroundColor = '#f5f7fb';
    }
  }, [isDark]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    sessionStorage.setItem(STORAGE_KEY, t);
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
