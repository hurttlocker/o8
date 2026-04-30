'use client';

/**
 * WaitingFooter — "Waiting for N agent(s)" surface above the composer
 * (#888/#894). Square stop button (one orange accent) cancels all
 * in-flight sub-agents for the active packet.
 *
 * Style: paper-and-ink Rams, Issues-style label, theme tokens. Inline
 * styles only. Reduced-motion is honored implicitly — there's nothing
 * to animate beyond the count text.
 */

import { memo } from 'react';

interface WaitingFooterProps {
  count: number;
  onStop: () => void;
  /** Optional label override — defaults to "agent(s)". */
  noun?: string;
}

function WaitingFooterBase({ count, onStop, noun = 'agent' }: WaitingFooterProps) {
  if (count <= 0) return null;
  const word = count === 1 ? noun : `${noun}s`;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 8,
        paddingRight: 14,
        paddingBottom: 8,
        paddingLeft: 14,
        borderTopWidth: '0.5px',
        borderTopStyle: 'solid',
        borderTopColor: 'var(--t-divider-subtle)',
        background: 'var(--t-panel-hover)',
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: '#FF5A1F',
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: 'var(--t-text-secondary)',
          letterSpacing: '-0.005em',
        }}
      >
        Waiting for{' '}
        <span style={{ color: 'var(--t-text)', fontWeight: 700 }}>{count}</span>{' '}
        {word}
      </span>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        onClick={onStop}
        title="Stop all in-flight agents"
        aria-label="Stop all in-flight agents"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 24,
          paddingTop: 0,
          paddingRight: 10,
          paddingBottom: 0,
          paddingLeft: 10,
          borderRadius: 6,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: '#FF5A1F',
          background: 'transparent',
          color: '#FF5A1F',
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          cursor: 'pointer',
          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        }}
        onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255, 90, 31, 0.08)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
      >
        <svg width={9} height={9} viewBox="0 0 24 24" fill="currentColor" aria-hidden style={{ display: 'block' }}>
          <rect x="6" y="6" width="12" height="12" rx="1" />
        </svg>
        Stop
      </button>
    </div>
  );
}

export const WaitingFooter = memo(WaitingFooterBase);
