/**
 * branch-rail-collapse — the Codex-style fold primitives for the
 * branch-details rail (Q 2026-07-13): the icon button used by both the
 * collapsed 44px column and the » control below the header.
 */

import type { ReactNode } from 'react';
import { BRANCH_RAIL_ACTION_RADIUS } from './branch-rail-geometry';

export function CollapsedRailIcon({
  title,
  onClick,
  children,
  resting = 'bare',
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  /**
   * `bare` — transparent until hovered. Correct inside the collapsed capsule,
   * which is already a card; a resting fill there would be a card in a card.
   * `card` — carries the card at rest. For actions sitting directly on the
   * overlay's paper, where a bare glyph reads as inline text (Q 2026-07-16).
   */
  resting?: 'bare' | 'card';
}) {
  const restBg = resting === 'card' ? 'var(--t-bg-card)' : 'transparent';
  const restBorder = resting === 'card' ? 'var(--t-divider-subtle, var(--t-divider))' : 'transparent';
  const restColor = resting === 'card' ? 'var(--t-text)' : 'var(--t-text-muted)';
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
        borderRadius: BRANCH_RAIL_ACTION_RADIUS,
        // Border is always present, transparent when bare: hovering a 0-width
        // border in would shift the glyph by a pixel.
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: restBorder,
        backgroundColor: restBg,
        color: restColor,
        cursor: 'pointer',
        flexShrink: 0,
        padding: 0,
        transition: 'background-color 120ms ease, border-color 120ms ease, color 120ms ease',
      }}
      // Hover lifts a small card — fill plus a hairline edge — rather than the
      // bare inline fill the left sidebar's rows use (Q 2026-07-16).
      onMouseEnter={(event) => {
        event.currentTarget.style.backgroundColor = 'var(--t-hover)';
        event.currentTarget.style.borderColor = 'var(--t-divider, var(--t-divider-subtle))';
        event.currentTarget.style.color = 'var(--t-text)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.backgroundColor = restBg;
        event.currentTarget.style.borderColor = restBorder;
        event.currentTarget.style.color = restColor;
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

