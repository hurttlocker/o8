'use client';

import { useState } from 'react';

export function SplitPaneCloseButton({ onClick, paneLabel }: { onClick: () => void; paneLabel?: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      data-no-drag
      onClick={onClick}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={paneLabel ? `Close ${paneLabel}` : 'Close pane'}
      title={paneLabel ? `Close ${paneLabel}` : 'Close pane'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 24,
        borderRadius: 6,
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color: hovered ? 'var(--t-text)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        paddingTop: 0,
        paddingRight: 8,
        paddingBottom: 0,
        paddingLeft: 8,
        fontSize: 11,
        fontWeight: 500,
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      Close
    </button>
  );
}
