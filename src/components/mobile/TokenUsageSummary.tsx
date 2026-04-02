'use client';

import { memo } from 'react';
import type { TokenUsageSummaryProps } from './types';
import { useTheme } from './ThemeContext';

export const TokenUsageSummary = memo(function TokenUsageSummary({ snapshot, onViewCosts }: TokenUsageSummaryProps) {
  const { colors } = useTheme();
  const tracked = snapshot.sessions.filter((session) => session.tokenUsage);
  const total = tracked.reduce((sum, session) => sum + (session.tokenUsage?.totalTokens ?? 0), 0);

  // Use context.usedPercent when available (weighted average across sessions).
  // Fall back to token ratio only if remainingTokens is actually reported.
  const sessionsWithContext = tracked.filter((s) => (s.context?.usedPercent ?? 0) > 0);
  let pct: number;
  if (sessionsWithContext.length > 0) {
    // Weighted average by tokens used
    const weightedSum = sessionsWithContext.reduce((sum, s) => sum + (s.context?.usedPercent ?? 0) * (s.tokenUsage?.totalTokens ?? 1), 0);
    const weightTotal = sessionsWithContext.reduce((sum, s) => sum + (s.tokenUsage?.totalTokens ?? 1), 0);
    pct = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : 0;
  } else {
    // No context data — check if remainingTokens is actually reported
    const hasRemaining = tracked.some((s) => (s.tokenUsage?.remainingTokens ?? 0) > 0);
    if (hasRemaining) {
      const cap = tracked.reduce(
        (sum, session) => sum + (session.tokenUsage?.totalTokens ?? 0) + (session.tokenUsage?.remainingTokens ?? 0),
        0,
      );
      pct = cap > 0 ? Math.round((total / cap) * 100) : 0;
    } else {
      // No remaining tokens data — don't show a misleading 100%
      pct = 0;
    }
  }

  if (!tracked.length) {
    return null;
  }

  const cardStyle = {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    padding: '14px 16px',
    borderRadius: 14,
    border: `1px solid ${colors.border}`,
    background: 'rgba(28,28,30,0.82)',
    color: colors.text,
    boxShadow: '0 16px 34px rgba(0,0,0,0.26)',
    cursor: 'pointer',
    textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
  } as const;
  const leftStyle = {
    minWidth: 0,
    display: 'grid',
    gap: 4,
  } as const;
  const kickerStyle = {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.02em',
  } as const;
  const valueStyle = {
    color: colors.text,
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: '-0.03em',
  } as const;
  const unitStyle = {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.02em',
  } as const;
  const rightStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as const;
  const ringStyle = {
    position: 'relative',
    width: 52,
    height: 52,
  } as const;
  const ringSvgStyle = {
    width: '100%',
    height: '100%',
    transform: 'rotate(-90deg)',
  } as const;
  const ringLabelStyle = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: colors.text,
    fontSize: 12,
    fontWeight: 700,
  } as const;

  return (
    <button
      type="button"
      style={cardStyle}
      onClick={onViewCosts}
    >
      <div style={leftStyle}>
        <span style={kickerStyle}>
          Token Usage · {tracked.length} session{tracked.length === 1 ? '' : 's'}
        </span>
        <strong style={valueStyle}>
          {total.toLocaleString()} <span style={unitStyle}>tokens</span>
        </strong>
      </div>
      <div style={rightStyle}>
        <div style={ringStyle}>
          <svg viewBox="0 0 36 36" style={ringSvgStyle}>
            <path
              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              fill="none"
              stroke="rgba(255,255,255,0.16)"
              strokeWidth="3"
            />
            <path
              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              fill="none"
              stroke={pct >= 75 ? '#ff3b30' : pct >= 50 ? '#ff9f0a' : '#34c759'}
              strokeWidth="3"
              strokeDasharray={`${pct}, 100`}
              strokeLinecap="round"
            />
          </svg>
          <span style={ringLabelStyle}>{pct}%</span>
        </div>
      </div>
    </button>
  );
});
