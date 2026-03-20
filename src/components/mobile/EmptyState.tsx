'use client';

/**
 * EmptyState — Personality-driven empty states.
 * "No agents running. Launch one?" with action button.
 */

import { memo } from 'react';

interface EmptyStateProps {
  iconPath: string;
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
  iconColor?: string;
}

export const EmptyState = memo(function EmptyState({
  iconPath, title, subtitle, actionLabel, onAction, iconColor = 'rgba(0,122,255,0.15)',
}: EmptyStateProps) {
  return (
    <div style={{
      padding: '48px 24px',
      textAlign: 'center',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', gap: 12,
    }}>
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none"
        stroke={iconColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
        style={{ opacity: 0.7 }}>
        <path d={iconPath} />
      </svg>
      <div>
        <p style={{
          fontSize: 15, fontWeight: 600, color: '#3c3c43',
          fontFamily: '-apple-system, system-ui, sans-serif',
          margin: 0,
        }}>
          {title}
        </p>
        {subtitle ? (
          <p style={{
            fontSize: 12, color: '#8e8e93', margin: '4px 0 0',
            fontFamily: '-apple-system, system-ui, sans-serif',
          }}>
            {subtitle}
          </p>
        ) : null}
      </div>
      {actionLabel && onAction ? (
        <button type="button"
          onClick={onAction}
          onTouchEnd={(e) => { e.preventDefault(); onAction(); }}
          style={{
            padding: '8px 20px', borderRadius: 10,
            background: '#007aff', color: '#fff',
            fontSize: 13, fontWeight: 600, border: 'none',
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
            marginTop: 4,
          }}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
});

/* Preset empty states */
export const EMPTY_STATES = {
  noAgents: {
    iconPath: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
    title: 'No agents running',
    subtitle: 'Launch one to get started.',
  },
  noIssues: {
    iconPath: 'M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3',
    title: 'All clear',
    subtitle: 'No open issues. Nice work.',
  },
  noPRs: {
    iconPath: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14L21 3',
    title: 'No open pull requests',
    subtitle: 'PRs will appear when agents push code.',
  },
  noActivity: {
    iconPath: 'M22 12h-4l-3 9L9 3l-3 9H2',
    title: 'No recent activity',
    subtitle: 'Agent actions will appear here.',
  },
  noChat: {
    iconPath: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    title: 'Select an agent to chat',
    subtitle: 'Pick from the squad picker above.',
  },
  noDeploys: {
    iconPath: 'M22 12l-4-4v3H3v2h15v3l4-4z',
    title: 'No deployments yet',
    subtitle: 'Deploy status will appear after your first push.',
  },
} as const;
