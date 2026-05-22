import type { TaskPoolGroup } from './types';

export const GROUP_LABELS: Record<TaskPoolGroup, string> = {
  ready: 'Ready',
  running: 'Running',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
};

export const GROUP_TONES: Record<TaskPoolGroup, {
  text: string;
  dot: string;
  soft: string;
}> = {
  ready: {
    text: 'var(--t-text-muted)',
    dot: 'var(--t-text-faint)',
    soft: 'var(--t-input-bg)',
  },
  running: {
    text: 'var(--t-accent)',
    dot: 'var(--t-accent)',
    soft: 'color-mix(in srgb, var(--t-accent) 10%, transparent)',
  },
  review: {
    text: 'var(--t-brand-orange, #FF5A1F)',
    dot: 'var(--t-brand-orange, #FF5A1F)',
    soft: 'rgba(255, 90, 31, 0.08)',
  },
  blocked: {
    text: '#dc2626',
    dot: '#ef4444',
    soft: 'rgba(239, 68, 68, 0.08)',
  },
  done: {
    text: '#15803d',
    dot: '#16a34a',
    soft: 'rgba(22, 163, 74, 0.08)',
  },
};

export const FLOATING_GLASS_SURFACE = 'color-mix(in srgb, var(--t-panel) 92%, transparent)';
export const FLAT_HOVER_SURFACE = 'color-mix(in srgb, var(--t-hover) 70%, transparent)';
export const FIELD_SURFACE = 'color-mix(in srgb, var(--t-panel) 88%, transparent)';
export const ONE_HOUR_MS = 60 * 60 * 1000;
export const STALE_FAILURE_MS = 6 * ONE_HOUR_MS;
export const STALE_ATTENTION_MS = 72 * ONE_HOUR_MS;
export const DETACHED_ATTENTION_MS = 24 * ONE_HOUR_MS;
export const STALE_CLEANUP_SIGNALS = new Set([
  'launch_error',
  'launch_failed',
  'relaunch_error',
  'session_lost',
  'zero_diff_failed',
  'silent_exit_work_present',
]);
