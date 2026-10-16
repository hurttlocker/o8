'use client';

import type { ReactNode } from 'react';
import { RAMS_BUTTON_GEOMETRY } from './control-geometry';
import { RAMS_ACCENT, RAMS_HAIRLINE_SOFT, RAMS_INK_QUIET, RAMS_CONTROL_BG, RAMS_CONTROL_BORDER, RAMS_CONTROL_ACTIVE_BG, RAMS_CONTROL_ACTIVE_BORDER } from './control-tokens';

export function RamsButton({
  children,
  onClick,
  disabled = false,
  variant = 'primary',
  type = 'button',
  busy = false,
  icon,
  width,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'solid' | 'ghost' | 'danger';
  type?: 'button' | 'submit';
  busy?: boolean;
  icon?: ReactNode;
  width?: number | string;
}) {
  const tone = variant === 'solid' ? 'var(--t-accent-contrast)' : variant === 'danger' ? '#d94f3a' : variant === 'ghost' ? 'var(--t-text-secondary)' : RAMS_ACCENT;
  const border = variant === 'solid' ? 'transparent' : variant === 'ghost'
    ? RAMS_CONTROL_BORDER
    : variant === 'danger'
      ? 'rgba(217, 79, 58, 0.32)'
      : RAMS_CONTROL_ACTIVE_BORDER;
  const bg = variant === 'solid' ? 'var(--t-accent)' : disabled
    ? 'transparent'
    : variant === 'ghost'
      ? RAMS_CONTROL_BG
      : variant === 'danger'
        ? 'rgba(217, 79, 58, 0.08)'
        : RAMS_CONTROL_ACTIVE_BG;
  // Symon voice-settings button shape (system sans, sentence case, 32h) kept on
  // o8's accent + variant colors. Was: mono / 10px / 300 / UPPERCASE / 44h.
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      style={{
        ...RAMS_BUTTON_GEOMETRY,
        width,
        gap: 7,
        borderColor: disabled && variant !== 'solid' ? RAMS_HAIRLINE_SOFT : border,
        background: bg,
        color: disabled && variant !== 'solid' ? RAMS_INK_QUIET : tone,
        cursor: disabled || busy ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
        opacity: variant === 'solid' && (disabled || busy) ? 0.45 : busy ? 0.7 : 1,
      }}
    >
      {icon ? <span style={{ display: 'inline-flex', flexShrink: 0 }}>{icon}</span> : null}
      <span>{children}</span>
    </button>
  );
}
