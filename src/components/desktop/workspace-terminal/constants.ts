import type { WorkspaceCliModelOption } from '@/components/desktop/workspace-terminal/types';

export const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[^[]/g;
export const LOCALHOST_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{3,5})\b[^\s)"]*/g;
export const IGNORED_PORTS = new Set([3000, 3002]);
export const ORCHESTRATED_TAB_AUTO_ARCHIVE_MS = 10 * 60_000;

export const CLI_AGENTS = [
  { id: 'shell', label: 'Terminal', color: '#64748b', command: null },
  { id: 'claude', label: 'Claude Code', color: '#e07a3a', command: 'claude' },
  { id: 'codex', label: 'Codex', color: '#6b7280', command: 'codex' },
  { id: 'gemini', label: 'Gemini CLI', color: '#4285f4', command: 'gemini' },
] as const;

export const CLAUDE_CLI_MODELS: WorkspaceCliModelOption[] = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6', color: '#8b5cf6' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', color: '#8b5cf6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', color: '#8b5cf6' },
];

export const CODEX_CLI_MODELS: WorkspaceCliModelOption[] = [
  { id: 'gpt-5.4', label: 'GPT-5.4', color: '#10b981' },
  { id: 'gpt-4o', label: 'GPT-4o', color: '#10b981' },
];

export const CLI_SUGGESTED_PROMPTS = [
  { icon: 'Idea', text: 'Summarize the current repo state', description: 'Quickly orient this CLI session to the local checkout' },
  { icon: 'Search', text: 'Find the files related to the current bug', description: 'Search the repo and point me to the likely change surface' },
  { icon: 'Test', text: 'Tell me what tests I should run next', description: 'Use the current branch and recent changes as context' },
  { icon: 'Notes', text: 'Explain what changed on this branch', description: 'Read the local diff and summarize the work in progress' },
];

export const THEME_ACCENT = 'var(--t-accent, #2563eb)';
export const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
export const THEME_ACCENT_SOFT_STRONG = 'var(--t-accent-soft-strong, rgba(37, 99, 235, 0.14))';
export const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(37, 99, 235, 0.22))';
export const THEME_ACCENT_RING = 'var(--t-accent-ring, rgba(37, 99, 235, 0.15))';
export const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
export const THEME_PANEL = 'var(--t-panel)';
export const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';

export function readThemeColor(name: string, fallback: string) {
  if (typeof window === 'undefined') return fallback;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function buildXtermTheme() {
  return {
    background: '#ffffff',
    foreground: '#111827',
    cursor: '#2563eb',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(37, 99, 235, 0.15)',
    selectionForeground: '#111827',
    black: '#111827',
    red: '#dc2626',
    green: '#16a34a',
    yellow: '#ca8a04',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: '#e5e7eb',
    brightBlack: '#6b7280',
    brightRed: '#ef4444',
    brightGreen: '#22c55e',
    brightYellow: '#eab308',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#06b6d4',
    brightWhite: '#f9fafb',
  };
}
