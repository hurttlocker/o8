'use client';

/**
 * IconButton — a small, themed, reusable icon button for canvas UI affordances
 * (open a tuner, toggle a panel, etc.). One place to get the eye-ergonomic
 * details right: themed ink, hover fill, an active/pressed state, and the
 * WebKit flex-collapse guard on the <svg> (flexShrink:0 + display:block) so the
 * glyph never vanishes inside the inline-flex button.
 *
 * Pass icon path content as children (raw <line>/<path>/<circle> on a 24-grid).
 */

import type { ReactNode } from 'react';
import { FONT } from './ui';

export function IconButton({
  label,
  onClick,
  active = false,
  size = 26,
  title,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  size?: number;
  title?: string;
  children: ReactNode;
}) {
  const idle = active ? 'rgba(255,255,255,0.12)' : 'transparent';
  const icon = Math.round(size * 0.56);
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={title ?? label}
      onClick={onClick}
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 0,
        borderRadius: 8,
        background: idle,
        color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
        cursor: 'pointer',
        fontFamily: FONT,
        flexShrink: 0,
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = active ? 'rgba(255,255,255,0.16)' : 'var(--cnv-edge)';
        event.currentTarget.style.color = 'var(--cnv-ink)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = idle;
        event.currentTarget.style.color = active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)';
      }}
    >
      <svg
        width={icon}
        height={icon}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        style={{ flexShrink: 0, display: 'block' }}
      >
        {children}
      </svg>
    </button>
  );
}
