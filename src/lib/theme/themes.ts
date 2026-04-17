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
  colorScheme: 'light' | 'dark';
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
    // Paired with Midnight — identical glass chrome over the OS vibrancy
    // backdrop, but the workspace/terminal/canvas surfaces stay solid white
    // so code and chat content read on a clean light canvas.
    description: 'Glass chrome over a white workspace',
    colorScheme: 'light',
    preview: {
      bg: '#f0f4f8',
      panel: '#f7f9fc',
      nav: '#eef2f7',
      titlebar: '#ffffff',
      accent: '#2563eb',
      text: '#111827',
      textMuted: '#6b7280',
    },
    cssVars: {
      // Chrome surfaces — translucent, bleed the vibrancy through. Kept
      // white-tinted rather than pure white so the native dark HudWindow
      // vibrancy underneath reads as "frosted silver glass" instead of a
      // hard white paint. Matches midnight's structural rgba choices but
      // inverted for a light palette.
      '--t-bg': 'rgba(244, 242, 237, 0.62)',
      '--t-bg-gradient': 'radial-gradient(circle at 0% 0%, rgba(244, 242, 237, 0.35) 0%, rgba(244, 242, 237, 0) 28%), linear-gradient(180deg, rgba(244, 242, 237, 0.56) 0%, rgba(238, 235, 227, 0.48) 100%)',
      '--t-bg-card': 'rgba(15, 23, 42, 0.04)',
      '--t-bg-subtle': 'rgba(244, 242, 237, 0.58)',
      '--t-panel': 'rgba(244, 242, 237, 0.58)',
      '--t-panel-translucent': 'rgba(244, 242, 237, 0.44)',
      '--t-panel-solid': 'linear-gradient(180deg, rgba(244, 242, 237, 0.92) 0%, rgba(238, 235, 227, 0.88) 100%)',
      '--t-panel-border': 'rgba(15, 23, 42, 0.1)',
      '--t-panel-shadow': '0 24px 60px rgba(15, 23, 42, 0.1)',
      '--t-panel-hover': 'rgba(15, 23, 42, 0.04)',
      '--t-panel-active': 'rgba(37, 99, 235, 0.1)',
      '--t-input-bg': 'rgba(244, 242, 237, 0.7)',
      '--t-input-border': 'rgba(15, 23, 42, 0.12)',
      '--t-border': 'rgba(15, 23, 42, 0.1)',
      '--t-text': '#0f172a',
      '--t-text-strong': '#020617',
      '--t-text-secondary': '#475569',
      '--t-text-muted': '#64748b',
      '--t-text-faint': '#94a3b8',
      '--t-accent': '#2563eb',
      '--t-accent-soft': 'rgba(37, 99, 235, 0.1)',
      '--t-accent-soft-strong': 'rgba(37, 99, 235, 0.18)',
      '--t-accent-border': 'rgba(37, 99, 235, 0.26)',
      '--t-accent-ring': 'rgba(37, 99, 235, 0.16)',
      '--t-celebration': '#c8923b',
      '--t-celebration-soft': 'rgba(200, 146, 59, 0.14)',
      '--t-celebration-border': 'rgba(200, 146, 59, 0.32)',
      '--t-celebration-glow': 'rgba(200, 146, 59, 0.32)',
      '--t-celebration-wash': 'linear-gradient(90deg, rgba(200, 146, 59, 0) 0%, rgba(200, 146, 59, 0.18) 46%, rgba(255, 255, 255, 0.36) 54%, rgba(200, 146, 59, 0.12) 100%)',
      // Chrome tokens are translucent — ThemeProvider will also force them
      // to transparent in Tauri so the OS vibrancy bleeds through. Non-Tauri
      // (dev browser) still sees the rgba values below.
      '--t-chrome': 'rgba(244, 242, 237, 0.5)',
      '--t-chrome-nav': 'rgba(244, 242, 237, 0.54)',
      '--t-chrome-timeline': 'rgba(244, 242, 237, 0.5)',
      '--t-divider': 'rgba(15, 23, 42, 0.08)',
      '--t-divider-strong': 'rgba(15, 23, 42, 0.14)',
      '--t-divider-subtle': 'rgba(15, 23, 42, 0.05)',
      '--t-hover': 'rgba(15, 23, 42, 0.04)',
      '--t-code-bg': 'rgba(15, 23, 42, 0.06)',
      '--t-drag-handle': 'rgba(15, 23, 42, 0.14)',
      '--t-search-bg': 'rgba(244, 242, 237, 0.5)',
      '--t-search-border': 'rgba(15, 23, 42, 0.08)',
      '--t-btn-secondary-bg': 'rgba(244, 242, 237, 0.55)',
      '--t-btn-secondary-border': 'rgba(15, 23, 42, 0.12)',
      '--t-btn-secondary-hover': 'rgba(15, 23, 42, 0.06)',
      // Chrome buttons (TitleBar / StatusBar / WorkspaceTerminal tabs). These
      // default to the chunky neomorphic white-pill preset. The
      // [data-chrome-surface="true"] override in ThemeProvider flips them to
      // a transparent glass preset for chrome regions that sit over the
      // vibrancy bleed in light mode (right panel, title bar right controls).
      '--t-chrome-btn-bg': 'rgba(244, 242, 237, 0.72)',
      '--t-chrome-btn-hover-bg': 'rgba(244, 242, 237, 0.88)',
      '--t-chrome-btn-active-bg': 'rgba(244, 242, 237, 0.98)',
      '--t-chrome-btn-shadow': '0 1px 3px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.8)',
      '--t-chrome-btn-hover-shadow': '0 2px 8px rgba(15, 23, 42, 0.1), 0 1px 2px rgba(15, 23, 42, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.9)',
      '--t-chrome-btn-active-shadow': '0 3px 10px rgba(15, 23, 42, 0.12), 0 1px 2px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.95)',
      '--t-kbd-bg': 'rgba(244, 242, 237, 0.68)',
      '--t-kbd-border': 'rgba(15, 23, 42, 0.14)',
      '--t-kbd-color': '#334155',
      '--t-canvas-bg': '#F4F2ED',
      '--t-tab-active-text': '#0f172a',
      '--t-tab-text': '#64748b',
      '--t-timeline-bar': 'rgba(248, 250, 253, 0.6)',
      '--t-shell-backdrop': 'rgba(248, 250, 253, 0.28)',
      '--t-glass-elevated': 'linear-gradient(180deg, rgba(244, 242, 237, 0.72) 0%, rgba(238, 235, 227, 0.6) 100%)',
      '--t-glass-muted': 'rgba(244, 242, 237, 0.5)',
      '--t-glass-muted-strong': 'rgba(244, 242, 237, 0.62)',
      '--t-glass-border-strong': 'rgba(15, 23, 42, 0.1)',
      '--t-glass-shadow': '0 32px 72px rgba(15, 23, 42, 0.12), 0 12px 32px rgba(15, 23, 42, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.9)',
      // Workspace / chat surface — solid paper (#F4F2ED). Panels upstream
      // are glass; the center content area where code and chat render is a
      // solid paper surface matching o8-site's landing. Mirrors how midnight
      // pins --t-chat-surface-* to a solid dark panel. See DESIGN.md §01.
      '--t-chat-surface-bg': '#F4F2ED',
      '--t-chat-surface-text': '#0f172a',
      '--t-chat-surface-text-secondary': '#475569',
      '--t-chat-surface-text-muted': '#64748b',
      '--t-chat-surface-border': 'rgba(15, 23, 42, 0.08)',
      '--t-chat-surface-input-bg': '#F4F2ED',
      '--t-chat-surface-input-border': 'rgba(15, 23, 42, 0.12)',
      '--t-chat-surface-card-bg': 'rgba(15, 23, 42, 0.04)',
      // Terminal palette — solid opaque paper (xterm canvas alpha bleeds).
      '--t-terminal-bg': '#F4F2ED',
      '--t-terminal-fg': '#0f172a',
      '--t-terminal-cursor': '#2563eb',
      '--t-terminal-cursor-accent': '#ffffff',
      '--t-terminal-selection-bg': 'rgba(37, 99, 235, 0.18)',
      '--t-terminal-selection-fg': '#0f172a',
      '--t-terminal-scrollbar-thumb': 'rgba(15, 23, 42, 0.16)',
      '--t-terminal-scrollbar-thumb-hover': 'rgba(15, 23, 42, 0.3)',
      '--t-terminal-ansi-black': '#111827',
      '--t-terminal-ansi-red': '#dc2626',
      '--t-terminal-ansi-green': '#16a34a',
      '--t-terminal-ansi-yellow': '#ca8a04',
      '--t-terminal-ansi-blue': '#2563eb',
      '--t-terminal-ansi-magenta': '#9333ea',
      '--t-terminal-ansi-cyan': '#0891b2',
      '--t-terminal-ansi-white': '#e5e7eb',
      '--t-terminal-ansi-bright-black': '#6b7280',
      '--t-terminal-ansi-bright-red': '#ef4444',
      '--t-terminal-ansi-bright-green': '#22c55e',
      '--t-terminal-ansi-bright-yellow': '#eab308',
      '--t-terminal-ansi-bright-blue': '#3b82f6',
      '--t-terminal-ansi-bright-magenta': '#a855f7',
      '--t-terminal-ansi-bright-cyan': '#06b6d4',
      '--t-terminal-ansi-bright-white': '#f9fafb',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Full dark — no light center',
    colorScheme: 'dark',
    preview: {
      bg: '#1a1d22',
      panel: '#282c33',
      nav: '#22262c',
      titlebar: '#1e2228',
      accent: '#8fb4ff',
      text: '#eef2f6',
      textMuted: '#8b95a3',
    },
    cssVars: {
      '--t-bg': 'rgba(22, 25, 30, 0.56)',
      '--t-bg-gradient': 'radial-gradient(circle at 0% 0%, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0) 22%), linear-gradient(180deg, rgba(32, 36, 42, 0.52) 0%, rgba(18, 20, 24, 0.48) 100%)',
      '--t-bg-card': 'rgba(255, 255, 255, 0.04)',
      '--t-bg-subtle': 'rgba(56, 62, 72, 0.28)',
      '--t-panel': 'rgba(62, 68, 78, 0.36)',
      '--t-panel-translucent': 'rgba(72, 78, 88, 0.28)',
      '--t-panel-solid': 'linear-gradient(180deg, rgba(42, 46, 54, 0.98) 0%, rgba(32, 36, 42, 0.96) 100%)',
      '--t-panel-border': 'rgba(255, 255, 255, 0.08)',
      '--t-panel-shadow': '0 24px 60px rgba(0, 0, 0, 0.36)',
      '--t-panel-hover': 'rgba(255, 255, 255, 0.06)',
      '--t-panel-active': 'rgba(143, 180, 255, 0.18)',
      '--t-input-bg': 'rgba(38, 42, 50, 0.5)',
      '--t-input-border': 'rgba(255, 255, 255, 0.1)',
      '--t-border': 'rgba(255, 255, 255, 0.08)',
      '--t-text': '#e8ecf2',
      '--t-text-strong': '#f5f8fc',
      '--t-text-secondary': '#bcc5d0',
      '--t-text-muted': '#8b95a3',
      '--t-text-faint': '#5f6b7a',
      '--t-accent': '#8fb4ff',
      '--t-accent-soft': 'rgba(143, 180, 255, 0.14)',
      '--t-accent-soft-strong': 'rgba(143, 180, 255, 0.22)',
      '--t-accent-border': 'rgba(143, 180, 255, 0.28)',
      '--t-accent-ring': 'rgba(143, 180, 255, 0.14)',
      '--t-celebration': '#f1c36a',
      '--t-celebration-soft': 'rgba(241, 195, 106, 0.14)',
      '--t-celebration-border': 'rgba(241, 195, 106, 0.3)',
      '--t-celebration-glow': 'rgba(241, 195, 106, 0.28)',
      '--t-celebration-wash': 'linear-gradient(90deg, rgba(241, 195, 106, 0) 0%, rgba(241, 195, 106, 0.2) 46%, rgba(255, 255, 255, 0.1) 54%, rgba(241, 195, 106, 0.14) 100%)',
      '--t-chrome': 'rgba(28, 32, 38, 0.48)',
      '--t-chrome-nav': 'rgba(34, 38, 45, 0.52)',
      '--t-chrome-timeline': 'rgba(36, 40, 48, 0.5)',
      '--t-divider': 'rgba(255, 255, 255, 0.06)',
      '--t-divider-strong': 'rgba(255, 255, 255, 0.1)',
      '--t-divider-subtle': 'rgba(255, 255, 255, 0.04)',
      '--t-hover': 'rgba(255, 255, 255, 0.05)',
      '--t-code-bg': 'rgba(0, 0, 0, 0.24)',
      '--t-drag-handle': 'rgba(255, 255, 255, 0.14)',
      '--t-search-bg': 'rgba(255, 255, 255, 0.05)',
      '--t-search-border': 'rgba(255, 255, 255, 0.08)',
      '--t-btn-secondary-bg': 'rgba(62, 68, 78, 0.38)',
      '--t-btn-secondary-border': 'rgba(255, 255, 255, 0.1)',
      '--t-btn-secondary-hover': 'rgba(255, 255, 255, 0.06)',
      '--t-chrome-btn-bg': 'rgba(22, 26, 34, 0.55)',
      '--t-chrome-btn-hover-bg': 'rgba(28, 34, 44, 0.7)',
      '--t-chrome-btn-active-bg': 'rgba(143, 180, 255, 0.18)',
      '--t-chrome-btn-shadow': '0 1px 3px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.07)',
      '--t-chrome-btn-hover-shadow': '0 2px 8px rgba(0, 0, 0, 0.32), 0 1px 2px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
      '--t-chrome-btn-active-shadow': 'inset 0 0 0 1px rgba(143, 180, 255, 0.36), 0 0 12px rgba(143, 180, 255, 0.28)',
      '--t-kbd-bg': 'rgba(255, 255, 255, 0.06)',
      '--t-kbd-border': 'rgba(255, 255, 255, 0.1)',
      '--t-kbd-color': '#d0d8e4',
      '--t-canvas-bg': 'rgba(28, 32, 38, 0.44)',
      '--t-tab-active-text': '#f5f8fc',
      '--t-tab-text': '#8b95a3',
      '--t-timeline-bar': 'rgba(62, 68, 78, 0.5)',
      '--t-shell-backdrop': 'rgba(10, 12, 16, 0.28)',
      '--t-glass-elevated': 'linear-gradient(180deg, rgba(82, 88, 98, 0.3) 0%, rgba(52, 58, 66, 0.2) 100%)',
      '--t-glass-muted': 'rgba(68, 74, 84, 0.2)',
      '--t-glass-muted-strong': 'rgba(78, 84, 94, 0.24)',
      '--t-glass-border-strong': 'rgba(255, 255, 255, 0.08)',
      '--t-glass-shadow': '0 32px 72px rgba(0, 0, 0, 0.36), 0 10px 24px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
      // Midnight-specific: override the LLM chat white surface
      '--t-chat-surface-bg': '#1a1e24',
      '--t-chat-surface-text': '#e8ecf2',
      '--t-chat-surface-text-secondary': '#8b95a3',
      '--t-chat-surface-text-muted': '#5f6b7a',
      '--t-chat-surface-border': 'rgba(255, 255, 255, 0.06)',
      '--t-chat-surface-input-bg': 'rgba(38, 42, 50, 0.5)',
      '--t-chat-surface-input-border': 'rgba(255, 255, 255, 0.1)',
      '--t-chat-surface-card-bg': 'rgba(255, 255, 255, 0.04)',
      // Terminal palette — midnight ships first so this is the reference tone.
      // Solid opaque colors — xterm pre-multiplies canvas pixels and alpha bleeds.
      '--t-terminal-bg': '#16191e',
      '--t-terminal-fg': '#e8ecf2',
      '--t-terminal-cursor': '#8fb4ff',
      '--t-terminal-cursor-accent': '#0f1216',
      '--t-terminal-selection-bg': 'rgba(143, 180, 255, 0.26)',
      '--t-terminal-selection-fg': '#ffffff',
      '--t-terminal-scrollbar-thumb': 'rgba(255, 255, 255, 0.12)',
      '--t-terminal-scrollbar-thumb-hover': 'rgba(255, 255, 255, 0.24)',
      '--t-terminal-ansi-black': '#16191e',
      '--t-terminal-ansi-red': '#f87171',
      '--t-terminal-ansi-green': '#86efac',
      '--t-terminal-ansi-yellow': '#fcd34d',
      '--t-terminal-ansi-blue': '#93c5fd',
      '--t-terminal-ansi-magenta': '#c4b5fd',
      '--t-terminal-ansi-cyan': '#67e8f9',
      '--t-terminal-ansi-white': '#d8dfe7',
      '--t-terminal-ansi-bright-black': '#5f6b7a',
      '--t-terminal-ansi-bright-red': '#fca5a5',
      '--t-terminal-ansi-bright-green': '#bbf7d0',
      '--t-terminal-ansi-bright-yellow': '#fde68a',
      '--t-terminal-ansi-bright-blue': '#bfdbfe',
      '--t-terminal-ansi-bright-magenta': '#ddd6fe',
      '--t-terminal-ansi-bright-cyan': '#a5f3fc',
      '--t-terminal-ansi-bright-white': '#f8fafc',
    },
  },
];
