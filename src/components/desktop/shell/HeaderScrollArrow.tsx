'use client';

import { useState } from 'react';

export function HeaderScrollArrow({
  side,
  onClick,
  rightOffset = 1,
}: {
  side: 'left' | 'right';
  onClick: () => void;
  rightOffset?: number;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      data-no-drag
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={side === 'left' ? 'Scroll tabs left' : 'Scroll tabs right'}
      title={side === 'left' ? 'Scroll left' : 'Scroll right'}
      style={{
        position: 'absolute',
        top: '50%',
        left: side === 'left' ? 1 : undefined,
        right: side === 'right' ? rightOffset : undefined,
        transform: 'translateY(-50%)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 20,
        height: 20,
        borderRadius: 6,
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'var(--t-input-bg)',
        color: hovered ? 'var(--t-text)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        padding: 0,
        boxShadow: 'var(--t-panel-shadow)',
        transition: 'background 120ms ease, color 120ms ease',
        zIndex: 2,
      }}
    >
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        {side === 'left' ? <path d="M15 18l-6-6 6-6" /> : <path d="M9 18l6-6-6-6" />}
      </svg>
    </button>
  );
}
