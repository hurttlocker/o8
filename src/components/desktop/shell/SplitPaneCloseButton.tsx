'use client';

import { useState } from 'react';

export function SplitPaneCloseButton({ onClick, paneLabel }: { onClick: () => void; paneLabel?: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      data-no-drag
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={paneLabel ? `Close split (${paneLabel})` : 'Close split'}
      title="Close split"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        borderRadius: 6,
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color: hovered ? 'var(--t-text)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
}
