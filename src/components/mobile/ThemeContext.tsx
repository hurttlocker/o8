'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

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

// LIGHT_COLORS — matches the visual feel of LIGHT_PALETTE in
// src/app/mobile/mobile-approvals-shared.tsx so wired tabs (Agents/Issues/
// Activity/Costs/Orchestrator) blend with Chats/Approvals topbar in light mode.
export const LIGHT_COLORS: ColorPalette = {
  bg: '#f5f3ef',
  surface: 'rgba(255,255,255,0.72)',
  surfaceBorder: 'rgba(0,0,0,0.08)',
  accent: '#2563eb',
  success: '#16a34a',
  danger: '#dc2626',
  text: '#1a1a2e',
  textSecondary: 'rgba(26,26,46,0.62)',
  textTertiary: 'rgba(26,26,46,0.48)',
  cardBg: 'rgba(255,255,255,0.6)',
  cardBorder: 'rgba(0,0,0,0.08)',
  elevatedSurface: 'rgba(255,255,255,0.82)',
  blueAccent: 'rgba(37,99,235,0.18)',
  blueGlass: 'rgba(37,99,235,0.08)',
  blueGlassBorder: 'rgba(37,99,235,0.2)',
  blueSoft: 'rgba(37,99,235,0.04)',
  composeBg: 'rgba(255,255,255,0.78)',
  composeBorder: 'rgba(0,0,0,0.1)',
  frostBg: 'rgba(255,255,255,0.92)',
  frostStrong: '#ffffff',
  panelBg: 'rgba(255,255,255,0.72)',
  msgUserBg: 'rgba(37,99,235,0.1)',
  msgAssistantBg: 'rgba(255,255,255,0.72)',
  border: 'rgba(0,0,0,0.08)',
  shadow: '0 8px 32px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.6)',
  green: '#16a34a',
  amber: '#d97706',
  red: '#dc2626',
  notifBg: 'rgba(37,99,235,0.08)',
  notifBorder: 'rgba(37,99,235,0.18)',
  dismissBg: 'rgba(37,99,235,0.1)',
  pillTextInactive: 'rgba(37,99,235,0.7)',
  activityTimelineLine: 'rgba(0,0,0,0.08)',
  activityCardBg: 'rgba(255,255,255,0.7)',
  activityCardBorder: 'rgba(0,0,0,0.08)',
  activityStatusCoding: '#2563eb',
  activityStatusThinking: '#3b82f6',
  activityStatusTesting: '#d97706',
  activityStatusError: '#dc2626',
  activityStatusSuccess: '#16a34a',
  activityStatusIdle: 'rgba(26,26,46,0.4)',
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

// Same key the desktop ThemeProvider (src/lib/theme/context.tsx) writes to.
// We follow it instead of forking, so picking Light in Settings flips the
// 5 wired mobile tabs in lock-step with the rest of the app.
const STORAGE_KEY = 'cortex-theme';

// Internal event we dispatch when the mobile setTheme is called in the same
// tab — `storage` events don't fire for same-tab writes, so we self-broadcast.
const MOBILE_THEME_CHANGE_EVENT = 'cortex-mobile-theme-change';

function readStoredThemeId(): string {
  if (typeof window === 'undefined') return 'midnight';
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? 'midnight';
  } catch {
    return 'midnight';
  }
}

function isLightThemeId(themeId: string): boolean {
  return themeId === 'light';
}

function legacyThemeFromId(themeId: string): Theme {
  // Legacy mobile API exposes 'light' | 'dark' | 'system'. Anything that is not
  // explicitly 'light' is treated as the dark variant (covers 'midnight',
  // 'dark', 'chocolate', etc).
  return isLightThemeId(themeId) ? 'light' : 'dark';
}

function themeIdFromLegacy(theme: Theme): string {
  if (theme === 'light') return 'light';
  // 'dark' and 'system' both land on midnight (the only shipping dark theme).
  return 'midnight';
}

interface ThemeProviderProps {
  children: ReactNode;
  // Optional bridge — when the parent already knows the theme id (e.g.
  // mobile-approvals-client subscribes to the desktop ThemeProvider via
  // its own useTheme hook), it can forward the value here so same-tab
  // changes propagate immediately without waiting for storage events.
  themeId?: string;
}

export function ThemeProvider({ children, themeId: themeIdProp }: ThemeProviderProps) {
  const [storedThemeId, setStoredThemeId] = useState<string>(() => readStoredThemeId());

  // Sync from storage events (other tabs/windows) and our self-broadcast event.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const refresh = () => {
      setStoredThemeId(readStoredThemeId());
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) refresh();
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener(MOBILE_THEME_CHANGE_EVENT, refresh);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(MOBILE_THEME_CHANGE_EVENT, refresh);
    };
  }, []);

  const themeId = themeIdProp ?? storedThemeId;
  const isDark = !isLightThemeId(themeId);
  const theme: Theme = legacyThemeFromId(themeId);
  const colors = isDark ? DARK_COLORS : LIGHT_COLORS;

  // Apply the same html/body background hint the legacy provider used so
  // anything that reads computed body bg sees the right tone. We avoid
  // forcing classes — desktop ThemeProvider owns the CSS-var application
  // path; we just touch the simple inline hints.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    const body = document.body;
    const bg = colors.bg;

    if (isDark) {
      html.classList.add('dark-mode');
      body.classList.add('dark-mode');
    } else {
      html.classList.remove('dark-mode');
      body.classList.remove('dark-mode');
    }
    html.style.backgroundColor = bg;
    body.style.backgroundColor = bg;
    html.style.colorScheme = isDark ? 'dark' : 'light';

    return () => {
      html.classList.remove('dark-mode');
      body.classList.remove('dark-mode');
      html.style.backgroundColor = '';
      body.style.backgroundColor = '';
      html.style.colorScheme = '';
    };
  }, [colors.bg, isDark]);

  const setTheme = useCallback((nextTheme: Theme) => {
    const nextThemeId = themeIdFromLegacy(nextTheme);
    try {
      window.localStorage.setItem(STORAGE_KEY, nextThemeId);
    } catch {
      // Ignore storage failures on constrained browsers.
    }
    setStoredThemeId(nextThemeId);
    try {
      window.dispatchEvent(new Event(MOBILE_THEME_CHANGE_EVENT));
    } catch {
      // Older browsers — fall back silently.
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(isDark ? 'light' : 'dark');
  }, [isDark, setTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, isDark, setTheme, toggle, colors }),
    [theme, isDark, setTheme, toggle, colors],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
