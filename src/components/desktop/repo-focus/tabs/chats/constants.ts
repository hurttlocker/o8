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
    // EXPERIMENT (Q 2026-07-14): no background pill on the active row — the
    // ShinyText title shimmer alone marks where you are. Previous value was
    // 'var(--t-input-bg)' (cream pill on solid / white-tint fog on glass);
    // restore it (possibly with rounded corners + softer alpha) if the
    // shimmer alone doesn't carry the selection.
    background: 'transparent',
    border: 'var(--t-divider-subtle)',
    iconBackground: 'color-mix(in srgb, var(--t-accent) 10%, transparent)',
    iconColor: 'var(--t-accent)',
  },
};
