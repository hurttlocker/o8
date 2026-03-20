'use client';

/**
 * CrossAgentPill — Whisper-thin indicator above compose bar.
 * "2 running" / "3 idle" — tap to jump to Agents view.
 * No layout-triggering animations. Pure opacity + transform (GPU-only).
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
        /* No transition on opacity — avoids jitter when parent re-renders */
      }}
    >
      {/* Tiny dot — pulse is opacity-only (no layout) */}
      <span style={{
        width: 4, height: 4, borderRadius: '50%',
        background: runningCount > 0 ? '#34c759' : '#8e8e93',
        willChange: runningCount > 0 ? 'opacity' : undefined,
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
      `}</style>
    </button>
  );
});
