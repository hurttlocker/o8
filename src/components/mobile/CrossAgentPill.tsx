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
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '4px 10px 4px 8px',
        borderRadius: 12,
        background: runningCount > 0 ? 'rgba(52,199,89,0.08)' : 'rgba(142,142,147,0.06)',
        border: `1px solid ${runningCount > 0 ? 'rgba(52,199,89,0.15)' : 'rgba(142,142,147,0.10)'}`,
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
        transition: 'all 300ms ease',
        animation: 'pillFadeIn 400ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      {/* Pulsing dot */}
      {runningCount > 0 ? (
        <span style={{
          width: 5, height: 5, borderRadius: '50%',
          background: '#34c759',
          boxShadow: '0 0 4px rgba(52,199,89,0.5)',
          animation: 'crossPulse 2s ease-in-out infinite',
        }} />
      ) : (
        <span style={{
          width: 5, height: 5, borderRadius: '50%',
          background: '#8e8e93',
        }} />
      )}

      <span style={{
        fontSize: 10, fontWeight: 700,
        color: runningCount > 0 ? '#34c759' : '#8e8e93',
        fontFamily: '-apple-system, system-ui, sans-serif',
        letterSpacing: '0.01em',
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
