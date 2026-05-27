import type { HistoryRowTone, HistoryToneKey } from './types';

export const HISTORY_ROW_TONES: Record<HistoryToneKey, HistoryRowTone> = {
  neutral: {
    key: 'neutral',
    accent: 'transparent',
    background: 'transparent',
    border: 'var(--t-divider-subtle)',
    iconBackground: 'transparent',
    iconColor: 'var(--t-text-muted)',
  },
  activity: {
    key: 'activity',
    accent: 'transparent',
    background: 'transparent',
    border: 'var(--t-divider-subtle)',
    iconBackground: 'transparent',
    iconColor: 'var(--t-text-muted)',
  },
  running: {
    key: 'running',
    accent: 'var(--t-accent)',
    background: 'transparent',
    border: 'var(--t-divider-subtle)',
    iconBackground: 'transparent',
    iconColor: 'var(--t-accent)',
    label: 'Running',
  },
  review: {
    key: 'review',
    accent: '#FF5A1F',
    background: 'transparent',
    border: 'var(--t-divider-subtle)',
    iconBackground: 'transparent',
    iconColor: '#FF5A1F',
    label: 'Review',
  },
  merged: {
    key: 'merged',
    accent: '#16a34a',
    background: 'transparent',
    border: 'var(--t-divider-subtle)',
    iconBackground: 'transparent',
    iconColor: '#15803d',
    label: 'Merged',
  },
  failed: {
    key: 'failed',
    accent: '#ef4444',
    background: 'transparent',
    border: 'var(--t-divider-subtle)',
    iconBackground: 'transparent',
    iconColor: '#dc2626',
    label: 'Blocked',
  },
  active: {
    key: 'active',
    accent: 'transparent',
    // Uses --t-input-bg which the AgentPanel card scopes per surface:
    //   - solid: --t-input-bg = rgba(244, 242, 237, 0.7) — cream pill (paper)
    //   - glass: scoped to rgba(255, 255, 255, 0.06) on the panel card so the
    //     selected row reads as a subtle white-tint highlight over vibrancy
    //     instead of a bright cream block (matches the o8.md tab approach).
    background: 'var(--t-input-bg)',
    border: 'var(--t-divider-subtle)',
    iconBackground: 'color-mix(in srgb, var(--t-accent) 10%, transparent)',
    iconColor: 'var(--t-accent)',
  },
};
