'use client';

/**
 * CrossAgentPill — Tiny floating indicator on chat page.
 * Shows "2 agents running" without leaving chat.
 * Taps to navigate to Agents view.
 */

import { memo } from 'react';

interface CrossAgentPillProps {
  runningCount: number;
  totalCount: number;
  onTap?: () => void;
}

export const CrossAgentPill = memo(function CrossAgentPill({
  runningCount,
  totalCount,
  onTap,
}: CrossAgentPillProps) {
  if (totalCount === 0) return null;

  return (
    <button
      type="button"
      onClick={onTap}
      onTouchEnd={(e) => { e.preventDefault(); onTap?.(); }}
      style={{
        display: 'flex', alignItems: 'center', gap: 3,
        padding: '2px 7px 2px 6px',
        borderRadius: 8,
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
        opacity: 0.55,
        transition: 'opacity 300ms ease',
        animation: 'pillFadeIn 400ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      {/* Tiny dot */}
      <span style={{
        width: 4, height: 4, borderRadius: '50%',
        background: runningCount > 0 ? '#34c759' : '#8e8e93',
        animation: runningCount > 0 ? 'crossPulse 2s ease-in-out infinite' : 'none',
      }} />

      <span style={{
        fontSize: 9, fontWeight: 500,
        color: '#8e8e93',
        fontFamily: '-apple-system, system-ui, sans-serif',
        letterSpacing: '0.02em',
      }}>
        {runningCount > 0 ? `${runningCount} running` : `${totalCount} idle`}
      </span>

      <style>{`
        @keyframes crossPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes pillFadeIn {
          from { opacity: 0; transform: scale(0.9); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </button>
  );
});
