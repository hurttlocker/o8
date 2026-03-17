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
    description: 'Rich, warm, and dark',
    preview: {
      bg: '#1a1412',
      panel: '#241b17',
      nav: '#1a1412',
      titlebar: '#16100e',
      accent: '#2563eb',
      text: '#ede4de',
      textMuted: '#6a5c54',
    },
    cssVars: {
      '--t-bg': '#110d0b',
      '--t-bg-gradient': 'linear-gradient(180deg, #1a1412 0%, #0d0a08 100%)',
      '--t-bg-subtle': '#1a1412',
      '--t-panel': '#241b17',
      '--t-panel-translucent': 'rgba(30, 22, 18, 0.92)',
      '--t-panel-border': 'rgba(180, 130, 100, 0.10)',
      '--t-panel-shadow': '0 2px 8px rgba(0, 0, 0, 0.4)',
      '--t-panel-hover': 'rgba(180, 130, 100, 0.06)',
      '--t-panel-active': 'rgba(180, 130, 100, 0.12)',
      '--t-input-bg': '#1a1412',
      '--t-input-border': 'rgba(180, 130, 100, 0.15)',
      '--t-text': '#ede4de',
      '--t-text-strong': '#f5f0ec',
      '--t-text-secondary': '#9a8a80',
      '--t-text-muted': '#6a5c54',
      '--t-text-faint': '#4a3f3a',
      '--t-chrome': 'rgba(18, 13, 11, 0.92)',
      '--t-chrome-nav': 'rgba(22, 16, 14, 0.92)',
      '--t-chrome-timeline': 'rgba(20, 15, 13, 0.92)',
      '--t-divider': 'rgba(180, 130, 100, 0.08)',
      '--t-divider-strong': 'rgba(180, 130, 100, 0.12)',
      '--t-divider-subtle': 'rgba(180, 130, 100, 0.04)',
      '--t-hover': 'rgba(180, 130, 100, 0.05)',
      '--t-code-bg': 'rgba(255, 200, 160, 0.06)',
      '--t-drag-handle': 'rgba(180, 130, 100, 0.15)',
      '--t-search-bg': 'rgba(180, 130, 100, 0.06)',
      '--t-search-border': 'rgba(180, 130, 100, 0.10)',
      '--t-btn-secondary-bg': '#2a201c',
      '--t-btn-secondary-border': 'rgba(180, 130, 100, 0.12)',
      '--t-btn-secondary-hover': 'rgba(180, 130, 100, 0.08)',
      '--t-canvas-bg': '#1a1412',
      '--t-tab-active-text': '#f5f0ec',
      '--t-tab-text': '#6a5c54',
      '--t-timeline-bar': '#2a201c',
    },
  },
];
