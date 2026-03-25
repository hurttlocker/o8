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
      '--t-bg-card': 'rgba(148, 163, 184, 0.08)',
      '--t-bg-subtle': '#f0f4f8',
      '--t-panel': '#ffffff',
      '--t-panel-translucent': 'rgba(255, 255, 255, 0.82)',
      '--t-panel-border': 'rgba(0, 0, 0, 0.06)',
      '--t-panel-shadow': '0 1px 3px rgba(0, 0, 0, 0.04)',
      '--t-panel-hover': 'rgba(0, 0, 0, 0.02)',
      '--t-panel-active': 'rgba(0, 0, 0, 0.06)',
      '--t-input-bg': '#ffffff',
      '--t-input-border': 'rgba(0, 0, 0, 0.1)',
      '--t-border': 'rgba(148, 163, 184, 0.28)',
      '--t-text': '#111827',
      '--t-text-strong': '#1e293b',
      '--t-text-secondary': '#6b7280',
      '--t-text-muted': '#9ca3af',
      '--t-text-faint': '#b0b8c4',
      '--t-accent': '#2563eb',
      '--t-accent-soft': 'rgba(37, 99, 235, 0.08)',
      '--t-accent-soft-strong': 'rgba(37, 99, 235, 0.14)',
      '--t-accent-border': 'rgba(37, 99, 235, 0.22)',
      '--t-accent-ring': 'rgba(37, 99, 235, 0.15)',
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
      '--t-kbd-bg': 'rgba(255, 255, 255, 0.9)',
      '--t-kbd-border': 'rgba(148, 163, 184, 0.36)',
      '--t-kbd-color': '#475569',
      '--t-canvas-bg': '#f8f9fc',
      '--t-tab-active-text': '#1e293b',
      '--t-tab-text': '#94a3b8',
      '--t-timeline-bar': '#f1f5f9',
    },
  },
  {
    id: 'dark',
    name: 'Dark Mode',
    description: 'Soft graphite glass',
    preview: {
      bg: '#2a2f35',
      panel: '#3d434b',
      nav: '#31363d',
      titlebar: '#272c31',
      accent: '#7aa2ff',
      text: '#f4f8fc',
      textMuted: '#a7b1bd',
    },
    cssVars: {
      '--t-bg': '#2a2f35',
      '--t-bg-gradient': 'linear-gradient(180deg, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0) 16%), radial-gradient(circle at 12% 0%, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0) 30%), radial-gradient(circle at 88% 100%, rgba(148, 163, 184, 0.12) 0%, rgba(148, 163, 184, 0) 34%), linear-gradient(180deg, #343a42 0%, #2b3138 56%, #23282f 100%)',
      '--t-bg-card': 'rgba(255, 255, 255, 0.045)',
      '--t-bg-subtle': '#343a42',
      '--t-panel': '#3d434b',
      '--t-panel-translucent': 'rgba(68, 75, 85, 0.84)',
      '--t-panel-border': 'rgba(255, 255, 255, 0.11)',
      '--t-panel-shadow': '0 24px 60px rgba(4, 8, 14, 0.34)',
      '--t-panel-hover': 'rgba(255, 255, 255, 0.06)',
      '--t-panel-active': 'var(--t-accent-soft)',
      '--t-input-bg': '#30353c',
      '--t-input-border': 'rgba(255, 255, 255, 0.14)',
      '--t-border': 'rgba(255, 255, 255, 0.12)',
      '--t-text': '#eef3f8',
      '--t-text-strong': '#fbfdff',
      '--t-text-secondary': '#c7d0da',
      '--t-text-muted': '#a7b1bd',
      '--t-text-faint': '#7a8693',
      '--t-accent': '#7aa2ff',
      '--t-accent-soft': 'rgba(122, 162, 255, 0.14)',
      '--t-accent-soft-strong': 'rgba(122, 162, 255, 0.2)',
      '--t-accent-border': 'rgba(122, 162, 255, 0.34)',
      '--t-accent-ring': 'rgba(122, 162, 255, 0.22)',
      '--t-chrome': 'rgba(40, 45, 52, 0.82)',
      '--t-chrome-nav': 'rgba(44, 49, 56, 0.88)',
      '--t-chrome-timeline': 'rgba(46, 51, 59, 0.84)',
      '--t-divider': 'rgba(255, 255, 255, 0.1)',
      '--t-divider-strong': 'rgba(255, 255, 255, 0.16)',
      '--t-divider-subtle': 'rgba(255, 255, 255, 0.04)',
      '--t-hover': 'rgba(255, 255, 255, 0.065)',
      '--t-code-bg': 'rgba(148, 163, 184, 0.16)',
      '--t-drag-handle': 'rgba(255, 255, 255, 0.2)',
      '--t-search-bg': 'rgba(255, 255, 255, 0.08)',
      '--t-search-border': 'rgba(255, 255, 255, 0.12)',
      '--t-btn-secondary-bg': '#49505a',
      '--t-btn-secondary-border': 'rgba(255, 255, 255, 0.14)',
      '--t-btn-secondary-hover': 'rgba(255, 255, 255, 0.08)',
      '--t-kbd-bg': 'rgba(255, 255, 255, 0.08)',
      '--t-kbd-border': 'rgba(255, 255, 255, 0.16)',
      '--t-kbd-color': '#e2e8f0',
      '--t-canvas-bg': '#2f353c',
      '--t-tab-active-text': '#fbfdff',
      '--t-tab-text': '#aab4bf',
      '--t-timeline-bar': '#49515b',
    },
  },
];
