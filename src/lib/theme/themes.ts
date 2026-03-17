/**
 * Theme definitions for Cortex IDE.
 *
 * Each theme provides CSS custom property values applied to <html>.
 * Components reference these via var(--t-xxx) in inline styles.
 */

export interface ThemeTokens {
  id: string;
  name: string;
  description: string;
  preview: {
    bg: string;
    panel: string;
    nav: string;
    titlebar: string;
    accent: string;
    text: string;
    textMuted: string;
  };
  cssVars: Record<string, string>;
}

export const themes: ThemeTokens[] = [
  {
    id: 'light',
    name: 'Light',
    description: 'Clean and bright',
    preview: {
      bg: '#f0f4f8',
      panel: '#ffffff',
      nav: '#f5f7fb',
      titlebar: '#ffffff',
      accent: '#2563eb',
      text: '#111827',
      textMuted: '#9ca3af',
    },
    cssVars: {
      '--t-bg': '#eef1f6',
      '--t-bg-gradient': 'linear-gradient(180deg, #f0f4f8 0%, #e8edf4 100%)',
      '--t-bg-subtle': '#f0f4f8',
      '--t-panel': '#ffffff',
      '--t-panel-translucent': 'rgba(255, 255, 255, 0.82)',
      '--t-panel-border': 'rgba(0, 0, 0, 0.06)',
      '--t-panel-shadow': '0 1px 3px rgba(0, 0, 0, 0.04)',
      '--t-panel-hover': 'rgba(0, 0, 0, 0.02)',
      '--t-panel-active': 'rgba(0, 0, 0, 0.06)',
      '--t-input-bg': '#ffffff',
      '--t-input-border': 'rgba(0, 0, 0, 0.1)',
      '--t-text': '#111827',
      '--t-text-strong': '#1e293b',
      '--t-text-secondary': '#6b7280',
      '--t-text-muted': '#9ca3af',
      '--t-text-faint': '#b0b8c4',
      '--t-chrome': 'rgba(255, 255, 255, 0.72)',
      '--t-chrome-nav': 'rgba(245, 247, 251, 0.82)',
      '--t-chrome-timeline': 'rgba(248, 250, 252, 0.85)',
      '--t-divider': 'rgba(0, 0, 0, 0.06)',
      '--t-divider-strong': 'rgba(0, 0, 0, 0.08)',
      '--t-divider-subtle': 'rgba(0, 0, 0, 0.04)',
      '--t-hover': 'rgba(0, 0, 0, 0.03)',
      '--t-code-bg': 'rgba(0, 0, 0, 0.04)',
      '--t-drag-handle': 'rgba(0, 0, 0, 0.08)',
      '--t-search-bg': 'rgba(0, 0, 0, 0.03)',
      '--t-search-border': 'rgba(0, 0, 0, 0.06)',
      '--t-btn-secondary-bg': '#ffffff',
      '--t-btn-secondary-border': 'rgba(0, 0, 0, 0.08)',
      '--t-btn-secondary-hover': 'rgba(0, 0, 0, 0.03)',
      '--t-canvas-bg': '#f8f9fc',
      '--t-tab-active-text': '#1e293b',
      '--t-tab-text': '#94a3b8',
      '--t-timeline-bar': '#f1f5f9',
    },
  },
  {
    id: 'chocolate',
    name: 'Chocolate',
    description: 'Sedona clay & milk cocoa',
    preview: {
      bg: '#2e1e14',
      panel: '#42301e',
      nav: '#36261c',
      titlebar: '#2a1c12',
      accent: '#c25c34',
      text: '#f2e8e0',
      textMuted: '#907660',
    },
    cssVars: {
      // Backgrounds — warm milk-chocolate brown, clearly edible
      '--t-bg': '#2e1e14',
      '--t-bg-gradient': 'linear-gradient(180deg, #36261c 0%, #261a10 100%)',
      '--t-bg-subtle': '#36261c',
      '--t-panel': '#42301e',
      '--t-panel-translucent': 'rgba(60, 42, 26, 0.92)',
      // Borders/shadows — Sedona red-rock terracotta
      '--t-panel-border': 'rgba(194, 92, 52, 0.14)',
      '--t-panel-shadow': '0 2px 8px rgba(0, 0, 0, 0.30)',
      '--t-panel-hover': 'rgba(194, 92, 52, 0.08)',
      '--t-panel-active': 'rgba(194, 92, 52, 0.16)',
      // Input
      '--t-input-bg': '#36261c',
      '--t-input-border': 'rgba(194, 92, 52, 0.20)',
      // Text — warm cream, desert sand tones
      '--t-text': '#f2e8e0',
      '--t-text-strong': '#f8f0e8',
      '--t-text-secondary': '#b89a80',
      '--t-text-muted': '#907660',
      '--t-text-faint': '#6a5444',
      // Chrome — chocolate glass
      '--t-chrome': 'rgba(38, 26, 16, 0.92)',
      '--t-chrome-nav': 'rgba(44, 30, 20, 0.94)',
      '--t-chrome-timeline': 'rgba(40, 28, 18, 0.92)',
      // Dividers — terracotta clay line
      '--t-divider': 'rgba(194, 92, 52, 0.12)',
      '--t-divider-strong': 'rgba(194, 92, 52, 0.18)',
      '--t-divider-subtle': 'rgba(194, 92, 52, 0.07)',
      // Interactive — red clay hover
      '--t-hover': 'rgba(194, 92, 52, 0.07)',
      '--t-code-bg': 'rgba(194, 120, 70, 0.10)',
      '--t-drag-handle': 'rgba(194, 92, 52, 0.22)',
      '--t-search-bg': 'rgba(194, 92, 52, 0.08)',
      '--t-search-border': 'rgba(194, 92, 52, 0.14)',
      // Buttons
      '--t-btn-secondary-bg': '#4e3826',
      '--t-btn-secondary-border': 'rgba(194, 92, 52, 0.18)',
      '--t-btn-secondary-hover': 'rgba(194, 92, 52, 0.12)',
      // Canvas/tabs
      '--t-canvas-bg': '#36261c',
      '--t-tab-active-text': '#f8f0e8',
      '--t-tab-text': '#907660',
      '--t-timeline-bar': '#4e3826',
    },
  },
];
