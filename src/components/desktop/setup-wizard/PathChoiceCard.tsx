'use client';

import type { ReactNode } from 'react';
import { ChevronRight } from '../lucide-shims';
import {
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_RING,
  THEME_ACCENT_SOFT,
  THEME_ACCENT_SOFT_STRONG,
  THEME_DIVIDER_SUBTLE,
  THEME_GLASS_MUTED,
  THEME_PANEL_BORDER,
  THEME_TEXT,
  THEME_TEXT_FAINT,
  THEME_TEXT_MUTED,
  THEME_TEXT_SECONDARY,
} from './theme';

export function PathChoiceCard({
  icon,
  title,
  description,
  selected,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 16px',
        borderRadius: 14,
        border: selected
          ? `1.5px solid ${THEME_ACCENT_BORDER}`
          : `1px solid ${THEME_PANEL_BORDER}`,
        background: selected
          ? THEME_ACCENT_SOFT_STRONG
          : THEME_GLASS_MUTED,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        width: '100%',
        transition: 'all 200ms ease',
        boxShadow: selected ? `0 14px 30px ${THEME_ACCENT_RING}` : 'none',
      }}
    >
      <span style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 36,
        height: 36,
        borderRadius: 10,
        background: selected ? THEME_ACCENT_SOFT : THEME_DIVIDER_SUBTLE,
        color: selected ? THEME_ACCENT : THEME_TEXT_MUTED,
        flexShrink: 0,
      }}>
        {icon}
      </span>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: THEME_TEXT, letterSpacing: '-0.01em' }}>
          {title}
        </div>
        <div style={{ fontSize: 12, color: THEME_TEXT_SECONDARY, marginTop: 2, lineHeight: 1.4 }}>
          {description}
        </div>
      </div>
      <ChevronRight size={16} strokeWidth={2} style={{
        marginLeft: 'auto',
        color: selected ? THEME_ACCENT : THEME_TEXT_FAINT,
        flexShrink: 0,
      }} />
    </button>
  );
}
