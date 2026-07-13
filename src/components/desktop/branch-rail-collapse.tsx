/**
 * branch-rail-collapse — the Codex-style fold primitives for the
 * branch-details rail (Q 2026-07-13): the icon button used by both the
 * collapsed 44px column and the » control below the header.
 */

import type { ReactNode } from 'react';

export function CollapsedRailIcon({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        width: 28,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
        borderWidth: 0,
        background: 'transparent',
        color: 'var(--t-text-muted)',
        cursor: 'pointer',
        flexShrink: 0,
        padding: 0,
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = 'var(--t-hover)';
        event.currentTarget.style.color = 'var(--t-text)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
        event.currentTarget.style.color = 'var(--t-text-muted)';
      }}
    >
      {children}
    </button>
  );
}

export function ChevronsRightIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="13 17 18 12 13 7" />
      <polyline points="6 17 11 12 6 7" />
    </svg>
  );
}

export function ChevronsLeftIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="11 17 6 12 11 7" />
      <polyline points="18 17 13 12 18 7" />
    </svg>
  );
}

